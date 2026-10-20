/** Optional server conversions (LibreOffice, pdf2docx), reached through the shared engine and its server client. */
import type { JobProgress, ToolId } from "../../../../../engine/src/types.ts";
import { getEngine } from "../../../lib/engine";

export type ProgressFn = (p: JobProgress) => void;

/**
 * True when the engine knows the tool AND the server lists it in /api/capabilities. Takes a plain string
 * because some ids (e.g. "pdf-to-docx") may not be in this build's ToolId union / registry yet.
 */
export async function serverHas(toolId: string): Promise<boolean> {
  try {
    const engine = await getEngine();
    if (!engine.getTool(toolId)) return false;
    const caps = await engine.capabilities();
    return caps.serverTools.includes(toolId as ToolId);
  } catch {
    return false;
  }
}

export async function runServerTool(toolId: string, file: File, options: Record<string, string>, onProgress: ProgressFn, signal: AbortSignal): Promise<Blob> {
  const engine = await getEngine();
  const r = await engine.run({ toolId: toolId as ToolId, files: [file], options, preferRuntime: "server" }, { onProgress, signal });
  const out = r.outputs[0];
  if (!out) throw new Error("The server returned no file.");
  return out.blob;
}
