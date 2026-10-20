/** Optional server conversions (LibreOffice, pdf2docx), reached through the shared engine and its server client. */
import type { JobProgress, ToolId } from "../../../../../engine/src/types.ts";
import { getEngine } from "../../../lib/engine";

export type ProgressFn = (p: JobProgress) => void;

/** True when the engine knows the tool AND the server lists it in /api/capabilities. */
export async function serverHas(toolId: ToolId): Promise<boolean> {
  try {
    const engine = await getEngine();
    if (!engine.getTool(toolId)) return false;
    const caps = await engine.capabilities();
    return caps.serverTools.includes(toolId);
  } catch {
    return false;
  }
}

export async function runServerTool(toolId: ToolId, file: File, options: Record<string, string>, onProgress: ProgressFn, signal: AbortSignal): Promise<Blob> {
  const engine = await getEngine();
  const r = await engine.run({ toolId, files: [file], options, preferRuntime: "server" }, { onProgress, signal });
  const out = r.outputs[0];
  if (!out) throw new Error("The server returned no file.");
  return out.blob;
}
