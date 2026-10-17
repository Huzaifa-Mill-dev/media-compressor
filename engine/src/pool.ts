/** Warm worker pool: workers are reused across jobs and only terminated on abort/crash/idle timeout. */
import { abortError, deserializeError, EngineError } from "./errors";
import type { FromWorker, ProcResult, RunMessage } from "./protocol";
import type { JobStage } from "./types";

export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
}

export interface PoolStats {
  created: number;
  terminated: number;
  idle: number;
  busy: number;
}

export class WorkerPool {
  private idle: { w: WorkerLike; timer: ReturnType<typeof setTimeout> | null }[] = [];
  private busy = new Set<WorkerLike>();
  private created = 0;
  private terminated = 0;

  constructor(
    private factory: () => WorkerLike,
    private opts: { maxIdle: number; idleMs: number } = { maxIdle: 4, idleMs: 60_000 },
  ) {}

  get stats(): PoolStats {
    return { created: this.created, terminated: this.terminated, idle: this.idle.length, busy: this.busy.size };
  }

  acquire(): WorkerLike {
    const e = this.idle.pop();
    if (e) {
      if (e.timer) clearTimeout(e.timer);
      this.busy.add(e.w);
      return e.w;
    }
    const w = this.factory();
    this.created++;
    this.busy.add(w);
    return w;
  }

  release(w: WorkerLike): void {
    if (!this.busy.delete(w)) return;
    w.onmessage = w.onerror = w.onmessageerror = null;
    if (this.idle.length >= this.opts.maxIdle) return this.kill(w);
    const entry = { w, timer: null as ReturnType<typeof setTimeout> | null };
    entry.timer = setTimeout(() => {
      const i = this.idle.indexOf(entry);
      if (i >= 0) {
        this.idle.splice(i, 1);
        this.kill(w);
      }
    }, this.opts.idleMs);
    (entry.timer as { unref?: () => void }).unref?.();
    this.idle.push(entry);
  }

  /** Terminate a busy worker (abort / crash). */
  discard(w: WorkerLike): void {
    this.busy.delete(w);
    w.onmessage = w.onerror = w.onmessageerror = null;
    this.kill(w);
  }

  private kill(w: WorkerLike): void {
    this.terminated++;
    try {
      w.terminate();
    } catch {
      /* already gone */
    }
  }

  dispose(): void {
    for (const e of this.idle) {
      if (e.timer) clearTimeout(e.timer);
      this.kill(e.w);
    }
    this.idle = [];
    for (const w of [...this.busy]) this.discard(w);
  }
}

/**
 * Run one job message on a pooled worker. Resolves with the processor result; rejects with
 * AbortError (worker terminated → work really stops) or the deserialised processor error.
 */
export function runOnWorker(
  pool: WorkerPool,
  msg: RunMessage,
  onProgress: (stage: JobStage, percent: number, message?: string) => void,
  signal: AbortSignal,
): Promise<ProcResult> {
  return new Promise<ProcResult>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    let w: WorkerLike;
    try {
      w = pool.acquire();
    } catch (e) {
      return reject(new EngineError("worker-start", `Couldn't start a background worker: ${(e as Error).message}`));
    }
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      pool.discard(w);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const fail = (err: Error, terminate: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) pool.discard(w);
      else pool.release(w);
      reject(err);
    };
    w.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (!m || m.id !== msg.id) return;
      if (m.type === "progress") onProgress(m.stage, m.percent, m.message);
      else if (m.type === "done") {
        if (settled) return;
        settled = true;
        cleanup();
        pool.release(w);
        resolve(m.result);
      } else if (m.type === "error") fail(deserializeError(m.error), false);
    };
    w.onerror = (ev: ErrorEvent) => {
      ev.preventDefault?.();
      fail(
        new EngineError("worker-crash", `The background worker crashed${ev.message ? `: ${ev.message}` : ""}. The file may be too large for this device.`),
        true,
      );
    };
    w.onmessageerror = () => fail(new EngineError("worker-crash", "Couldn't read the worker's response."), true);
    try {
      w.postMessage(msg);
    } catch (e) {
      fail(new EngineError("worker-start", `Couldn't send the file to a worker: ${(e as Error).message}`), true);
    }
  });
}
