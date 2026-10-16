/**
 * Video/audio processor. NOTE (known limitation): the mediabunny/ffmpeg.wasm browser path is not implemented in
 * this build; the processor reports "browser-unsupported" so Engine.run falls back to the server runtime.
 */
import { EngineError } from "../errors";
import type { ProcCtx, ProcResult } from "../protocol";

export async function processMedia(_ctx: ProcCtx): Promise<ProcResult> {
  throw new EngineError("browser-unsupported", "In-browser audio/video processing isn't available yet; using the server.");
}
