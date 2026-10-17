import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolId } from "@contracts/types";
import type { ServerConfig } from "./config.js";
import { AbortError, HttpError, JobError, MemoryLimitError, TimeoutError } from "./errors.js";
import type { Logger } from "./log.js";
import type { Binaries } from "./probe.js";
import { PROCESSORS } from "./processors/index.js";
import type { ProcInput } from "./processors/types.js";
import type { Stats } from "./stats.js";
import type { ResolvedOptions, ServerTool } from "./tools.js";
import { mimeForExt } from "./util.js";

export type JobStatus = "queued" | "processing" | "done" | "error" | "cancelled";

export interface JobOutput {
  name: string;
  size: number;
  mime: string;
  path: string;
}

export interface Job {
  id: string;
  tool: ServerTool;
  options: ResolvedOptions;
  dir: string;
  inputs: ProcInput[];
  status: JobStatus;
  percent: number;
  message?: string;
  outputs: JobOutput[];
  meta?: Record<string, unknown>;
  error?: string;
  inputBytes: number;
  abort: AbortController;
  expiresAt?: number;
}

/** What clients see (no server paths). */
export function publicJob(j: Job, position?: number) {
  return {
    id: j.id,
    tool: j.tool.id,
    status: j.status,
    percent: Math.round(j.percent),
    message: j.message,
    queuePosition: j.status === "queued" ? position : undefined,
    outputs: j.status === "done" ? j.outputs.map((o, i) => ({ name: o.name, size: o.size, mime: o.mime, url: `/api/jobs/${j.id}/outputs/${i}` })) : undefined,
    meta: j.status === "done" ? j.meta : undefined,
    error: j.error,
  };
}

const TERMINAL = new Set<JobStatus>(["done", "error", "cancelled"]);
export const isTerminal = (s: JobStatus) => TERMINAL.has(s);

export class JobManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private waiting: Record<"heavy" | "light", Job[]> = { heavy: [], light: [] };
  private running = { heavy: 0, light: 0 };
  private reserved = 0;
  private timers = new Map<string, NodeJS.Timeout>();
  private closed = false;
  private inflight = new Set<Promise<void>>();

  constructor(
    private cfg: ServerConfig,
    private bins: Binaries,
    private stats: Stats,
    private log: Logger,
  ) {
    super();
    this.setMaxListeners(0);
  }

  /** Remove leftovers of a previous run. */
  async sweep(): Promise<void> {
    await fs.mkdir(this.cfg.jobsDir, { recursive: true });
    for (const e of await fs.readdir(this.cfg.jobsDir)) await fs.rm(path.join(this.cfg.jobsDir, e), { recursive: true, force: true });
  }

  /** Active = uploading, queued or running. */
  get active(): number {
    return this.reserved + this.waiting.heavy.length + this.waiting.light.length + this.running.heavy + this.running.light;
  }

  /** Reserve a slot while the upload streams in; throws 429 when full. Call `release()` (or `submit`). */
  reserve(): () => void {
    if (this.closed || this.active >= this.cfg.maxQueue) throw new HttpError(429, "The server is busy right now. Please try again in a minute.", "queue_full");
    this.reserved++;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        this.reserved--;
      }
    };
  }

  newJobDir(): { id: string; dir: string } {
    const id = randomUUID();
    return { id, dir: path.join(this.cfg.jobsDir, id) };
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  position(job: Job): number | undefined {
    const q = this.waiting[job.tool.queue];
    const i = q.indexOf(job);
    return i < 0 ? undefined : i + 1;
  }

  submit(job: Job): void {
    this.jobs.set(job.id, job);
    this.waiting[job.tool.queue].push(job);
    this.emitChange(job);
    this.pump();
  }

  cancel(job: Job): void {
    if (isTerminal(job.status)) return;
    if (job.status === "queued") {
      const q = this.waiting[job.tool.queue];
      const i = q.indexOf(job);
      if (i >= 0) q.splice(i, 1);
      this.finish(job, "cancelled", "Cancelled");
      this.pump();
    } else {
      job.abort.abort(); // the run() promise rejects with AbortError → finish()
    }
  }

  private pump(): void {
    for (const kind of ["heavy", "light"] as const) {
      const limit = kind === "heavy" ? this.cfg.heavyConcurrency : this.cfg.lightConcurrency;
      while (!this.closed && this.running[kind] < limit && this.waiting[kind].length) {
        const job = this.waiting[kind].shift()!;
        this.running[kind]++;
        const p: Promise<void> = this.execute(job).finally(() => {
          this.inflight.delete(p);
          this.running[kind]--;
          this.pump();
        });
        this.inflight.add(p);
        for (const j of this.waiting[kind]) this.emitChange(j); // queue positions moved
      }
    }
  }

  private async execute(job: Job): Promise<void> {
    job.status = "processing";
    job.percent = 1;
    job.message = "Starting";
    this.emitChange(job);
    const outDir = path.join(job.dir, "out");
    const workDir = path.join(job.dir, "work");
    const timeout = setTimeout(() => job.abort.abort(new TimeoutError()), job.tool.timeoutMs * this.cfg.timeoutScale);
    try {
      await fs.mkdir(outDir, { recursive: true });
      await fs.mkdir(workDir, { recursive: true });
      let last = 0;
      const res = await PROCESSORS[job.tool.id]({
        toolId: job.tool.id,
        inputs: job.inputs,
        options: job.options,
        outDir,
        workDir,
        signal: job.abort.signal,
        cfg: this.cfg,
        bins: this.bins,
        progress: (p, m) => {
          const pct = Math.max(job.percent, Math.min(99, p));
          if (pct - last < 1 && m === undefined) return;
          last = pct;
          job.percent = pct;
          if (m !== undefined) job.message = m;
          this.emitChange(job);
        },
      });
      if (job.abort.signal.aborted) throw new AbortError();
      const outputs: JobOutput[] = [];
      for (const o of res.outputs) {
        const st = await fs.stat(o.path);
        outputs.push({ name: o.name, size: st.size, mime: mimeForExt(path.extname(o.name).slice(1)), path: o.path });
      }
      if (!outputs.length) throw new JobError("No output was produced");
      job.outputs = outputs;
      job.meta = res.meta;
      this.finish(job, "done", "Done");
      const outBytes = outputs.reduce((a, o) => a + o.size, 0);
      this.stats.record(job.tool.id, job.inputBytes, outBytes);
    } catch (e) {
      const reason = job.abort.signal.reason;
      if (e instanceof AbortError || (e instanceof Error && e.name === "AbortError" && !(reason instanceof TimeoutError))) this.finish(job, "cancelled", "Cancelled");
      else if (e instanceof TimeoutError || reason instanceof TimeoutError) this.finish(job, "error", undefined, "Processing took too long and was stopped.");
      else if (e instanceof MemoryLimitError) this.finish(job, "error", undefined, e.message);
      else if (e instanceof JobError) this.finish(job, "error", undefined, e.message);
      else {
        this.log.error("job failed", { job: job.id, tool: job.tool.id, err: e instanceof Error ? e.message.slice(0, 300) : String(e) });
        this.finish(job, "error", undefined, "Something went wrong while processing this file.");
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private finish(job: Job, status: JobStatus, message?: string, error?: string): void {
    job.status = status;
    job.message = message;
    job.error = error;
    if (status === "done") job.percent = 100;
    job.expiresAt = Date.now() + this.cfg.outputTtlMs;
    this.emitChange(job);
    // Inputs are never needed again; failed/cancelled jobs have nothing to download.
    void rmQuiet(path.join(job.dir, "in"));
    void rmQuiet(path.join(job.dir, "work"));
    if (status !== "done") void rmQuiet(job.dir);
    this.timers.set(job.id, setTimeout(() => this.remove(job.id), this.cfg.outputTtlMs).unref());
  }

  /** Delete a job and its files (DELETE route, TTL). */
  remove(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.jobs.delete(id);
    void rmQuiet(job.dir);
  }

  private emitChange(job: Job): void {
    this.emit("change", job.id);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    for (const j of this.jobs.values()) if (!isTerminal(j.status)) j.abort.abort();
    await Promise.allSettled([...this.inflight]);
    await Promise.all([...this.jobs.values()].map((j) => fs.rm(j.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
    this.jobs.clear();
  }
}

/** Best-effort recursive delete (a concurrent delete or a briefly locked file must never crash the server). */
const rmQuiet = (p: string): Promise<void> => fs.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
