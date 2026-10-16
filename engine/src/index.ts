/** Public surface of the engine package. The UI imports only from here. */
import { abortError, EngineError, isAbortError } from "./errors";
import { readHead } from "./formats";
import { normalizeOptions, defaultsFor } from "./options";
import { runOnWorker, WorkerPool } from "./pool";
import { MAIN_THREAD_TOOLS, workerKindFor, type WorkerKind } from "./protocol";
import { planJob, type BrowserEnv, type FileInfo, type ServerEnv } from "./routing";
import { Scheduler } from "./scheduler";
import { fetchServerCaps, runOnServer } from "./server-client";
import { getTool, tools } from "./tools";
import type { Capabilities, Engine, JobInput, JobProgress, JobResult, RunHandlers, Runtime, ToolId } from "./types";
import { createWorker } from "./worker-factories";

export { tools, getTool };
export type * from "./types";

export interface EngineOptions {
  serverBaseUrl?: string;
  concurrency?: number;
  /** Where copy-assets put static assets (default "/vendor/"). */
  vendorBase?: string;
}
export type EngineHandle = Engine & { dispose(): void; readonly scheduler: Scheduler };

export function detectBrowserEnv(): BrowserEnv {
  const g = globalThis as Record<string, unknown>;
  return {
    webCodecs: typeof g.VideoEncoder !== "undefined" && typeof g.AudioEncoder !== "undefined",
    wasm: typeof WebAssembly !== "undefined",
    workers: typeof g.Worker !== "undefined",
    offscreenCanvas: typeof g.OffscreenCanvas !== "undefined",
    crossOriginIsolated: g.crossOriginIsolated === true,
  };
}

export const defaultConcurrency = (): number => {
  const hc = (globalThis.navigator?.hardwareConcurrency as number | undefined) ?? 2;
  return Math.max(1, Math.min(4, hc - 1));
};

export function createEngine(opts: EngineOptions = {}): EngineHandle {
  const base = (opts.serverBaseUrl ?? "").replace(/\/$/, "");
  const limit = Math.max(1, Math.floor(opts.concurrency ?? defaultConcurrency()));
  const vendorBase = (opts.vendorBase ?? "/vendor/").replace(/\/?$/, "/");
  const scheduler = new Scheduler({ limit, lanes: { media: limit >= 4 ? 2 : 1 } });
  const pools = new Map<WorkerKind, WorkerPool>();
  const poolFor = (k: WorkerKind) => {
    let p = pools.get(k);
    if (!p) pools.set(k, (p = new WorkerPool(() => createWorker(k), { maxIdle: limit, idleMs: 60_000 })));
    return p;
  };
  let caps: { at: number; v: ServerEnv | null } | null = null;
  const serverEnv = async (): Promise<ServerEnv | null> => {
    if (caps && Date.now() - caps.at < 30_000) return caps.v;
    const v = await fetchServerCaps(base);
    caps = { at: Date.now(), v };
    return v;
  };
  let jobSeq = 0;

  async function infos(files: File[]): Promise<FileInfo[]> {
    return Promise.all(files.map(async (f) => ({ name: f.name, size: f.size, head: await readHead(f, 64).catch(() => undefined) })));
  }

  const engine: EngineHandle = {
    tools,
    getTool,
    scheduler,
    defaults: (id: ToolId) => defaultsFor(getTool(id)!),
    async plan(input: JobInput) {
      const tool = getTool(input.toolId);
      if (!tool) return { runtime: null, reason: `Unknown tool "${input.toolId}".` };
      let options;
      try {
        options = normalizeOptions(tool, input.options);
      } catch (e) {
        return { runtime: null, reason: (e as Error).message };
      }
      const server = tool.runtimes.includes("server") ? await serverEnv() : null;
      return planJob(tool, await infos(input.files), options, detectBrowserEnv(), server, input.preferRuntime);
    },
    async capabilities(): Promise<Capabilities> {
      const env = detectBrowserEnv();
      const s = await serverEnv();
      return {
        webCodecs: env.webCodecs,
        crossOriginIsolated: env.crossOriginIsolated,
        hardwareConcurrency: (globalThis.navigator?.hardwareConcurrency as number | undefined) ?? 1,
        serverTools: s?.tools ?? [],
      };
    },
    async run(input: JobInput, handlers: RunHandlers = {}): Promise<JobResult> {
      const tool = getTool(input.toolId);
      if (!tool) throw new EngineError("bad-tool", `Unknown tool "${input.toolId}".`);
      const options = normalizeOptions(tool, input.options);
      const signal = handlers.signal;
      if (signal?.aborted) throw abortError();
      const decision = await engine.plan({ ...input, options });
      if (decision.runtime === null) throw new EngineError("unsupported", decision.reason);

      let last = 0;
      let runtime: Runtime = decision.runtime;
      const emit = (p: JobProgress) => {
        last = Math.max(last, Math.min(99, Math.round(p.percent)));
        handlers.onProgress?.({ ...p, percent: p.stage === "queued" ? Math.min(last, 1) : last, runtime });
      };
      emit({ stage: "queued", percent: 0, runtime });
      const started = performance.now();

      const runBrowser = (sig: AbortSignal): Promise<JobResult> => {
        const id = ++jobSeq;
        const kind = workerKindFor(input.toolId);
        const progress = (stage: JobProgress["stage"], percent: number, message?: string) => emit({ stage, percent, message, runtime: "browser" });
        const env = { vendorBase, crossOriginIsolated: detectBrowserEnv().crossOriginIsolated, hardwareConcurrency: (globalThis.navigator?.hardwareConcurrency as number | undefined) ?? 1 };
        const proc = MAIN_THREAD_TOOLS.has(input.toolId)
          ? import("./processors/pdf-render").then((m) => m.processPdfToImages({ toolId: input.toolId, files: input.files, options, env, progress, signal: sig }))
          : runOnWorker(poolFor(kind), { type: "run", id, toolId: input.toolId, files: input.files, options, env }, progress, sig);
        return proc.then((r) => ({ runtime: "browser" as const, inputSize: input.files.reduce((a, f) => a + f.size, 0), outputs: r.outputs, meta: r.meta, durationMs: 0 }));
      };
      const runServer = async (sig: AbortSignal): Promise<JobResult> => ({ ...(await runOnServer(base, input.toolId, input.files, options, emit, sig)), durationMs: 0 });

      const lane = workerKindFor(input.toolId) === "media" ? "media" : "light";
      try {
        const result = await scheduler.schedule(
          lane,
          async (sig) => {
            if (runtime === "browser") {
              try {
                return await runBrowser(sig);
              } catch (e) {
                // Browser can't handle this particular file → server fallback, if the server offers the tool.
                if (e instanceof EngineError && e.code === "browser-unsupported" && !isAbortError(e) && input.preferRuntime !== "browser") {
                  const s = tool.runtimes.includes("server") ? await serverEnv() : null;
                  if (s?.tools.includes(input.toolId)) {
                    runtime = "server";
                    return runServer(sig);
                  }
                }
                throw e;
              }
            }
            return runServer(sig);
          },
          { signal, onStart: () => emit({ stage: runtime === "server" ? "uploading" : "loading-engine", percent: 1, runtime }) },
        );
        result.durationMs = Math.round(performance.now() - started);
        handlers.onProgress?.({ stage: "done", percent: 100, runtime });
        return result;
      } catch (e) {
        handlers.onProgress?.({ stage: isAbortError(e) ? "cancelled" : "error", percent: last, runtime });
        throw e;
      }
    },
    dispose() {
      for (const p of pools.values()) p.dispose();
      pools.clear();
    },
  };
  return engine;
}
