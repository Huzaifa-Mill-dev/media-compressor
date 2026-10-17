/**
 * Video/audio in the browser.
 *  - Fast path: mediabunny + WebCodecs (hardware encoders where available), streamed from a Blob.
 *  - Fallback: ffmpeg.wasm (video→GIF, AVI/OGV/3GP input, browsers without WebCodecs) — see media-ffmpeg.ts.
 * Anything neither path can do throws "browser-unsupported", which makes Engine.run use the server runtime.
 * Cancellation: the job's worker is terminated by the runner, so no cooperative checks are needed here.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  FlacOutputFormat,
  Input,
  MkvOutputFormat,
  MovOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  WavOutputFormat,
  WebMOutputFormat,
  canEncodeAudio,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type OutputFormat,
  type VideoCodec,
} from "mediabunny";
import { EngineError } from "../errors";
import { extOf, mimeOf, outName } from "../formats";
import type { ProcCtx, ProcResult } from "../protocol";
import { mediaPath } from "../routing";
import { audioFormatOf, isLossless, planVideo, targetSize, targetVideoBitrate, type AudioFormat, type Container, type VCodec } from "./media-plan";

const detectWebCodecs = () => typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined";

export async function processMedia(ctx: ProcCtx): Promise<ProcResult> {
  const file = ctx.files[0];
  if (!file) throw new EngineError("bad-input", "No file selected.");
  const path = mediaPath(ctx.toolId, extOf(file.name), ctx.options, { webCodecs: detectWebCodecs(), wasm: typeof WebAssembly !== "undefined" });
  if (typeof path === "object") throw new EngineError("browser-unsupported", path.reason);
  if (path === "ffmpeg") return (await import("./media-ffmpeg")).processWithFfmpeg(ctx);
  try {
    return await processWithMediabunny(ctx, file);
  } catch (e) {
    // A container/codec mediabunny can't handle → try ffmpeg.wasm (when it is allowed) before giving up.
    if (e instanceof EngineError && e.code === "mediabunny-unsupported") {
      return (await import("./media-ffmpeg")).processWithFfmpeg(ctx);
    }
    throw e;
  }
}

// ── container / codec tables ────────────────────────────────────────────────────────────────────────
function videoOutputFormat(c: Container): OutputFormat {
  switch (c) {
    case "webm":
      return new WebMOutputFormat();
    case "mkv":
      return new MkvOutputFormat();
    case "mov":
      return new MovOutputFormat({ fastStart: "in-memory" });
    default:
      return new Mp4OutputFormat({ fastStart: "in-memory" });
  }
}

const AUDIO_TARGET: Record<AudioFormat, { make: () => OutputFormat; codec: AudioCodec; ext: string; register?: () => Promise<void> }> = {
  mp3: { make: () => new Mp3OutputFormat(), codec: "mp3", ext: "mp3", register: async () => (await import("@mediabunny/mp3-encoder")).registerMp3Encoder() },
  m4a: { make: () => new Mp4OutputFormat({ fastStart: "in-memory" }), codec: "aac", ext: "m4a", register: async () => (await import("@mediabunny/aac-encoder")).registerAacEncoder() },
  ogg: { make: () => new OggOutputFormat(), codec: "opus", ext: "ogg" },
  opus: { make: () => new OggOutputFormat(), codec: "opus", ext: "opus" },
  wav: { make: () => new WavOutputFormat(), codec: "pcm-s16", ext: "wav" },
  flac: { make: () => new FlacOutputFormat(), codec: "flac", ext: "flac", register: async () => (await import("@mediabunny/flac-encoder")).registerFlacEncoder() },
};

/** Make sure an encoder for `codec` exists, registering the WASM encoder package when WebCodecs lacks it. */
async function ensureAudioEncoder(f: AudioFormat): Promise<AudioCodec> {
  const t = AUDIO_TARGET[f];
  if (!(await canEncodeAudio(t.codec))) {
    if (!t.register) throw new EngineError("mediabunny-unsupported", `${f.toUpperCase()} encoding isn't available in this browser.`);
    await t.register();
    if (!(await canEncodeAudio(t.codec))) throw new EngineError("mediabunny-unsupported", `${f.toUpperCase()} encoding isn't available in this browser.`);
  }
  return t.codec;
}

/** WebCodecs encoder present, or (AAC) registered from the WASM encoder package. */
async function ensureEncodable(codec: AudioCodec): Promise<boolean> {
  if (await canEncodeAudio(codec)) return true;
  if (codec === "aac") {
    (await import("@mediabunny/aac-encoder")).registerAacEncoder();
    return canEncodeAudio(codec);
  }
  return false;
}

function openInput(file: File): Input {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

const unreadable = (file: File, e: unknown) =>
  new EngineError("corrupt", `${file.name} couldn't be read as a video/audio file — it may be corrupt or in an unsupported format (${String((e as Error)?.message ?? e).slice(0, 100)}).`);

async function processWithMediabunny(ctx: ProcCtx, file: File): Promise<ProcResult> {
  const audioOnly = ctx.toolId === "audio-convert" || ctx.toolId === "audio-compress" || ctx.toolId === "video-to-audio";
  ctx.progress("loading-engine", 2, "Reading file");
  const input = openInput(file);
  try {
    let vt: Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>;
    let at: Awaited<ReturnType<Input["getPrimaryAudioTrack"]>>;
    try {
      vt = await input.getPrimaryVideoTrack();
      at = await input.getPrimaryAudioTrack();
    } catch (e) {
      // Unknown container → give ffmpeg.wasm a chance; otherwise it is simply not a media file.
      if (/unsupported|unknown|no.*format|input/i.test(String((e as Error)?.message))) throw new EngineError("mediabunny-unsupported", String((e as Error).message));
      throw unreadable(file, e);
    }
    if (audioOnly) return await toAudio(ctx, file, input, at);
    if (!vt) {
      if (!at && !vt) throw new EngineError("mediabunny-unsupported", `${file.name} has no tracks mediabunny can read.`);
      throw new EngineError("bad-input", `${file.name} has no video track.`);
    }
    return await toVideo(ctx, file, input, vt, at);
  } finally {
    input.dispose?.();
  }
}

async function finish(ctx: ProcCtx, file: File, out: Output<OutputFormat, BufferTarget>, ext: string, extra: Record<string, unknown>, compress: boolean): Promise<ProcResult> {
  const buf = out.target.buffer;
  if (!buf || buf.byteLength === 0) throw new EngineError("corrupt", "Conversion produced an empty file.");
  // Never hand back something larger than the upload (compression tools only).
  if (compress && buf.byteLength >= file.size) {
    return { outputs: [{ blob: file, filename: outName(file.name, extOf(file.name) || ext), mime: file.type || mimeOf(extOf(file.name)), size: file.size }], meta: { ...extra, keptOriginal: true } };
  }
  const blob = new Blob([buf], { type: mimeOf(ext) });
  return { outputs: [{ blob, filename: outName(file.name, ext), mime: mimeOf(ext), size: blob.size }], meta: { ...extra, keptOriginal: false } };
}

async function run(ctx: ProcCtx, conv: Conversion, out: Output, from: number, span: number): Promise<void> {
  if (!conv.isValid) {
    const why = conv.discardedTracks.map((d) => d.reason).join(", ");
    throw new EngineError("mediabunny-unsupported", `This file can't be converted in the browser (${why || "no usable tracks"}).`);
  }
  conv.onProgress = (p) => ctx.progress("processing", from + p * span, undefined);
  try {
    await conv.execute();
  } catch (e) {
    await out.cancel().catch(() => {});
    throw new EngineError("corrupt", `Conversion failed: ${String((e as Error)?.message ?? e).slice(0, 140)}`);
  }
}

async function toAudio(ctx: ProcCtx, file: File, input: Input, at: Awaited<ReturnType<Input["getPrimaryAudioTrack"]>>): Promise<ProcResult> {
  if (!at) throw new EngineError("bad-input", `${file.name} has no audio track.`);
  const { format, bps } = audioFormatOf(ctx.toolId, ctx.options);
  const codec = await ensureAudioEncoder(format);
  const t = AUDIO_TARGET[format];
  const out = new Output({ format: t.make(), target: new BufferTarget() });
  const audio: Record<string, unknown> = { codec, forceTranscode: true };
  if (!isLossless(format)) audio.bitrate = bps;
  const conv = await Conversion.init({ input, output: out, video: { discard: true }, audio });
  ctx.progress("processing", 8, "Converting audio");
  await run(ctx, conv, out, 8, 86);
  const duration = await input.computeDuration().catch(() => undefined);
  return finish(ctx, file, out as Output<OutputFormat, BufferTarget>, t.ext, { durationSec: duration, codec }, ctx.toolId === "audio-compress");
}

async function toVideo(ctx: ProcCtx, file: File, input: Input, vt: NonNullable<Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>>, at: Awaited<ReturnType<Input["getPrimaryAudioTrack"]>>): Promise<ProcResult> {
  const plan = planVideo(ctx.toolId, ctx.options);
  const w = vt.displayWidth;
  const h = vt.displayHeight;
  // Same memory guard as the server: true 4K+ is capped to 1080p unless the user chose a resolution.
  const ultra = w * h > 2560 * 1440 || Math.max(w, h) > 2560;
  const size = targetSize(w, h, plan.capShort ?? (ultra ? 1080 : undefined));
  const stats = await vt.computePacketStats(120).catch(() => null);
  const sourceBps = stats && stats.averageBitrate > 0 ? stats.averageBitrate : undefined;
  const fps = stats && stats.averagePacketRate > 0 ? stats.averagePacketRate : 30;
  const duration = await input.computeDuration().catch(() => 0);

  const format = videoOutputFormat(plan.container);
  const supported = new Set<string>(format.getSupportedVideoCodecs?.() ?? format.getSupportedCodecs());
  const candidates = plan.codecs.filter((c) => supported.has(c)) as VideoCodec[];
  const bitrateFor = (c: VCodec) => targetVideoBitrate({ width: size.width, height: size.height, fps, bpp: plan.bpp, codec: c, sourceBps });
  const codec = await getFirstEncodableVideoCodec(candidates, { width: size.width, height: size.height, bitrate: bitrateFor(candidates[0] as VCodec) });
  if (!codec) throw new EngineError("browser-unsupported", `This browser can't encode ${plan.container.toUpperCase()} video (no usable encoder).`);

  let audio: Record<string, unknown>;
  if (plan.stripAudio || !at) audio = { discard: true };
  else {
    const acodec: AudioCodec = plan.container === "webm" || plan.container === "mkv" ? "opus" : "aac";
    const ok = await ensureEncodable(acodec);
    audio = ok ? { codec: acodec, bitrate: plan.audioBps, forceTranscode: true } : { discard: true };
  }

  const out = new Output({ format, target: new BufferTarget() });
  const video: Record<string, unknown> = { codec, bitrate: bitrateFor(codec as VCodec), forceTranscode: true };
  if (size.scaled) Object.assign(video, { width: size.width, height: size.height, fit: "fill" });
  const conv = await Conversion.init({ input, output: out, video, audio });
  ctx.progress("processing", 8, "Encoding video");
  await run(ctx, conv, out, 8, 86);
  return finish(
    ctx,
    file,
    out as Output<OutputFormat, BufferTarget>,
    plan.container,
    { width: w, height: h, outputWidth: size.width, outputHeight: size.height, durationSec: duration, codec, profile: plan.profile },
    ctx.toolId === "video-compress",
  );
}
