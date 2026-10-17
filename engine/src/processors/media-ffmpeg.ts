/**
 * ffmpeg.wasm fallback: video→GIF, AVI/OGV/3GP input, and browsers without WebCodecs.
 * The single-thread core is self-hosted under `<vendorBase>ffmpeg/st/` (copy-assets). The multithreaded core
 * (@ffmpeg/core-mt) is deliberately NOT used: it starts but deadlocks inside filter graphs in Chromium. This path is a
 * fallback (GIF, AVI/OGV/3GP, no WebCodecs), so reliability beats speed; inputs are capped (FFMPEG_MAX_BYTES).
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { EngineError } from "../errors";
import { extOf, mimeOf, outName } from "../formats";
import type { ProcCtx, ProcResult } from "../protocol";
import { FFMPEG_MAX_BYTES } from "../routing";
import { ffmpegArgs } from "./ffmpeg-args";
import { audioFormatOf, planVideo } from "./media-plan";

function outputExt(ctx: ProcCtx): string {
  if (ctx.toolId === "video-to-audio" || ctx.toolId === "audio-convert" || ctx.toolId === "audio-compress") return audioFormatOf(ctx.toolId, ctx.options).format === "m4a" ? "m4a" : audioFormatOf(ctx.toolId, ctx.options).format;
  if (ctx.toolId === "video-convert" && ctx.options.format === "gif") return "gif";
  return planVideo(ctx.toolId, ctx.options).container;
}

export async function processWithFfmpeg(ctx: ProcCtx): Promise<ProcResult> {
  const file = ctx.files[0]!;
  if (file.size > FFMPEG_MAX_BYTES) throw new EngineError("browser-unsupported", `${file.name} is too large for the in-browser fallback encoder.`);
  const ext = outputExt(ctx);
  const inExt = extOf(file.name) || "bin";
  // Absolute: ffmpeg.wasm resolves the core inside its own nested worker, where relative URLs would break.
  const base = new URL(`${ctx.env.vendorBase}ffmpeg/st/`, self.location.href).href;
  const args = ffmpegArgs(ctx.toolId, ctx.options, `in.${inExt}`, `out.${ext}`, ext);

  ctx.progress("loading-engine", 3, "Loading video engine");
  const ff = new FFmpeg();
  let lastLog = "";
  ff.on("log", ({ message }) => {
    lastLog = message;
  });
  ff.on("progress", ({ progress }) => {
    if (Number.isFinite(progress)) ctx.progress("processing", 10 + Math.min(1, Math.max(0, progress)) * 82);
  });
  try {
    await ff.load({
      coreURL: `${base}ffmpeg-core.js`,
      wasmURL: `${base}ffmpeg-core.wasm`,
    });
  } catch (e) {
    ff.terminate();
    throw new EngineError("browser-unsupported", `The fallback encoder couldn't start (${String((e as Error)?.message ?? e).slice(0, 80)}).`);
  }
  try {
    ctx.progress("processing", 8, "Reading file");
    await ff.writeFile(`in.${inExt}`, new Uint8Array(await file.arrayBuffer()));
    ctx.progress("processing", 10, "Converting");
    const code = await ff.exec(args);
    if (code !== 0) throw new EngineError("corrupt", `${file.name} couldn't be converted — it may be corrupt or use an unsupported codec (${lastLog.slice(0, 100)}).`);
    const data = (await ff.readFile(`out.${ext}`)) as Uint8Array;
    if (!data || data.byteLength === 0) throw new EngineError("corrupt", "Conversion produced an empty file.");
    const blob = new Blob([data as BlobPart], { type: mimeOf(ext) });
    return { outputs: [{ blob, filename: outName(file.name, ext), mime: mimeOf(ext), size: blob.size }], meta: { codec: "ffmpeg.wasm", keptOriginal: false } };
  } finally {
    ff.terminate();
  }
}
