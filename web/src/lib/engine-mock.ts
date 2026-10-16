/**
 * Deterministic fake engine used ONLY by UI tests (enabled with the build-time flag
 * PUBLIC_TEST_HOOKS=1 plus `window.__MT_MOCK__` set by the test). It implements the
 * same `Engine` contract as the real engine so the UI can be exercised without codecs.
 *
 * Behaviour knobs (all optional) on `window.__MT_MOCK__`:
 *   stepMs        – delay between progress ticks (default 40)
 *   steps         – number of progress ticks (default 5)
 *   failPattern   – filenames matching this regex reject with an Error
 *   serverTools   – tool ids the "server" can run (default: none → server offline)
 *   outputs       – number of outputs per job (default 1, pdf-split/pdf-to-images 3)
 *   qualityScore  – meta.qualityScore to report
 *   runtime       – force reported runtime
 */
import type {
  Capabilities,
  Engine,
  JobInput,
  JobOutput,
  JobResult,
  Options,
  RunHandlers,
  Runtime,
  ToolDefinition,
  ToolId,
} from "../../../engine/src/types.ts";
import { tools } from "./registry";

export interface MockConfig {
  stepMs?: number;
  steps?: number;
  failPattern?: string;
  serverTools?: ToolId[];
  outputs?: number;
  qualityScore?: number;
  runtime?: Runtime;
}

/** The mock serves the real registry, so forms/SEO and tests exercise the genuine option schemas. */
export const mockTools: ToolDefinition[] = tools;

function cfg(): MockConfig {
  return ((globalThis as unknown as { __MT_MOCK__?: MockConfig }).__MT_MOCK__ ?? {}) as MockConfig;
}

function abortError(): Error {
  const e = new Error("The job was cancelled");
  e.name = "AbortError";
  return e;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true },
    );
  });
}

export function createMockEngine(): Engine {
  const getTool = (idOrSlug: string) => mockTools.find((t) => t.id === idOrSlug || t.slug === idOrSlug);
  const defaults = (toolId: ToolId): Options => {
    const out: Options = {};
    for (const f of getTool(toolId)?.options ?? []) out[f.key] = f.default;
    return out;
  };
  const serverTools = () => cfg().serverTools ?? [];
  const decide = (input: JobInput): Runtime | null => {
    const t = getTool(input.toolId);
    if (!t) return null;
    for (const r of t.runtimes) {
      if (r === "browser") return "browser";
      if (r === "server" && serverTools().includes(t.id)) return "server";
    }
    return null;
  };
  return {
    tools: mockTools,
    getTool,
    defaults,
    async plan(input) {
      const r = decide(input);
      return r ? { runtime: r } : { runtime: null, reason: "This tool needs our server, which is unavailable right now." };
    },
    async run(input: JobInput, handlers: RunHandlers = {}): Promise<JobResult> {
      const c = cfg();
      const runtime = c.runtime ?? decide(input);
      if (!runtime) throw new Error("This tool needs our server, which is unavailable right now.");
      const t0 = performance.now();
      const steps = c.steps ?? 5;
      handlers.onProgress?.({ stage: "loading-engine", percent: 0, runtime });
      for (let i = 1; i <= steps; i++) {
        await sleep(c.stepMs ?? 40, handlers.signal);
        handlers.onProgress?.({ stage: "processing", percent: Math.round((i / steps) * 95), runtime, message: `Step ${i}/${steps}` });
      }
      if (c.failPattern && input.files.some((f) => new RegExp(c.failPattern!).test(f.name))) {
        throw new Error(`Mock failure for <b>${input.files[0]!.name}</b>`);
      }
      const first = input.files[0]!;
      const multi = input.toolId === "pdf-split" || input.toolId === "pdf-to-images";
      const count = c.outputs ?? (multi ? 3 : 1);
      const fmt = String(input.options.format ?? first.name.split(".").pop() ?? "bin");
      const base = first.name.replace(/\.[^.]*$/, "");
      const outputs: JobOutput[] = [];
      for (let i = 0; i < count; i++) {
        const blob = new Blob([await first.arrayBuffer()], { type: first.type || "application/octet-stream" });
        const filename = count > 1 ? `${base}-${i + 1}.${fmt}` : `${base}.${fmt}`;
        outputs.push({ blob, filename, mime: blob.type, size: blob.size });
      }
      handlers.onProgress?.({ stage: "done", percent: 100, runtime });
      return {
        runtime,
        inputSize: input.files.reduce((s, f) => s + f.size, 0),
        outputs,
        durationMs: performance.now() - t0,
        meta: c.qualityScore !== undefined ? { qualityScore: c.qualityScore } : {},
      };
    },
    async capabilities(): Promise<Capabilities> {
      return { webCodecs: "VideoEncoder" in globalThis, crossOriginIsolated: globalThis.crossOriginIsolated === true, hardwareConcurrency: navigator.hardwareConcurrency || 1, serverTools: serverTools() };
    },
  };
}
