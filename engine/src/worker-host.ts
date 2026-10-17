/** Shared worker entry: receives run messages, dispatches to the processor for the tool, reports progress/result. */
import { serializeError } from "./errors";
import type { FromWorker, ProcCtx, Processor, ToWorker } from "./protocol";
import type { ToolId } from "./types";

export type ProcessorLoader = () => Promise<Processor>;

export function serveWorker(loaders: Partial<Record<ToolId, ProcessorLoader>>): void {
  const scope = self as unknown as {
    onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
    postMessage(m: FromWorker): void;
  };
  scope.onmessage = async (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== "run") return;
    const { id } = msg;
    const post = (m: FromWorker) => scope.postMessage(m);
    let last = 0;
    const ctx: ProcCtx = {
      toolId: msg.toolId,
      files: msg.files,
      options: msg.options,
      env: msg.env,
      progress(stage, percent, message) {
        // Monotonic, and never 100 until the result is delivered.
        last = Math.max(last, Math.min(99, Math.round(percent)));
        post({ type: "progress", id, stage, percent: last, message });
      },
    };
    try {
      const load = loaders[msg.toolId];
      if (!load) throw new Error(`No processor for ${msg.toolId} in this worker.`);
      ctx.progress("loading-engine", 1, "Loading…");
      const proc = await load();
      const result = await proc(ctx);
      post({ type: "done", id, result });
    } catch (e) {
      post({ type: "error", id, error: serializeError(e) });
    }
  };
}
