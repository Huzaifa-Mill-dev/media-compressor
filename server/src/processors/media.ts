import fs from "node:fs/promises";
import path from "node:path";
import { JobError } from "../errors.js";
import { run, safeEnv } from "../proc.js";
import { safeBaseName } from "../util.js";
import type { ProcCtx, ProcResult } from "./types.js";

interface Probe {
  width: number;
  height: number;
  duration: number;
  bitrate: number;
  audioBitrate: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

async function ffprobe(file: string, ctx: ProcCtx, name: string): Promise<Probe> {
  const r = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { signal: ctx.signal, timeoutMs: 30_000, env: safeEnv() });
  if (r.code !== 0) throw new JobError(`${name} isn't a readable media file`);
  let j: { streams?: Record<string, string | number>[]; format?: Record<string, string> };
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new JobError(`${name} isn't a readable media file`);
  }
  const v = j.streams?.find((s) => s.codec_type === "video" && s.disposition_attached_pic !== 1);
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const p: Probe = {
    width: Number(v?.width ?? 0),
    height: Number(v?.height ?? 0),
    duration: Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0) || 0,
    bitrate: Number(j.format?.bit_rate ?? 0) || 0,
    audioBitrate: Number(a?.bit_rate ?? 0) || 0,
    hasVideo: !!v,
    hasAudio: !!a,
  };
  if (p.duration > ctx.cfg.maxMediaSeconds) throw new JobError(`${name} is longer than the ${Math.round(ctx.cfg.maxMediaSeconds / 3600)} h limit`);
  if (p.width * p.height > ctx.cfg.maxVideoPixels) throw new JobError(`${name} has a frame size above the server limit`);
  return p;
}

/** Cap the SHORTER side at `n` px, keep even dimensions, never upscale. */
const capShort = (n: number) => `scale='if(gt(iw,ih),-2,min(${n},iw))':'if(gt(iw,ih),min(${n},ih),-2)'`;
const RES: Record<string, number> = { "480p": 480, "720p": 720, "1080p": 1080, "1440p": 1440 };
const EVEN = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
const GUARD_1080 = "scale=min(1920\\,iw):min(1080\\,ih):force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2";

const AUDIO: Record<string, { codec: string[]; ext: string; lossy: boolean; enc?: string }> = {
  mp3: { codec: ["-c:a", "libmp3lame"], ext: "mp3", lossy: true, enc: "libmp3lame" },
  m4a: { codec: ["-c:a", "aac"], ext: "m4a", lossy: true, enc: "aac" },
  ogg: { codec: ["-c:a", "libopus"], ext: "ogg", lossy: true, enc: "libopus" },
  opus: { codec: ["-c:a", "libopus"], ext: "opus", lossy: true, enc: "libopus" },
  wav: { codec: ["-c:a", "pcm_s16le"], ext: "wav", lossy: false },
  flac: { codec: ["-c:a", "flac"], ext: "flac", lossy: false },
};

function need(ctx: ProcCtx, enc: string, label: string): void {
  if (!ctx.bins.encoders.has(enc)) throw new JobError(`${label} encoding isn't available on this server`);
}

async function ffmpeg(ctx: ProcCtx, args: string[], durationSec: number, base: number, span: number, rssLimitMb: number, timeoutMs: number): Promise<void> {
  let buf = "";
  const r = await run("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats", ...args], {
    signal: ctx.signal,
    timeoutMs: timeoutMs * ctx.cfg.timeoutScale,
    rssLimitMb,
    memLimitMb: rssLimitMb ? 0 : ctx.cfg.childMemLimitMb,
    env: safeEnv(),
    onStdout: (d) => {
      buf = (buf + d).slice(-600);
      const m = [...buf.matchAll(/out_time_us=(\d+)/g)].pop();
      if (m && durationSec > 0) ctx.progress(Math.min(base + span, base + (Number(m[1]) / 1e6 / durationSec) * span));
    },
  });
  if (r.code !== 0) throw new JobError(`Conversion failed: ${r.stderr.trim().split("\n").pop()?.slice(0, 200) || "unsupported or corrupt media"}`);
}

export async function processMedia(ctx: ProcCtx): Promise<ProcResult> {
  const input = ctx.inputs[0]!;
  const o = ctx.options;
  const tool = ctx.toolId;
  ctx.progress(3, "Inspecting");
  const pr = await ffprobe(input.path, ctx, input.name);
  const baseName = safeBaseName(input.name, "media");

  // ---- audio-only outputs ----------------------------------------------------------------------
  if (tool === "audio-convert" || tool === "audio-compress" || tool === "video-to-audio") {
    if (!pr.hasAudio) throw new JobError(`${input.name} has no audio track`);
    const f = AUDIO[String(o.format)]!;
    if (f.enc) need(ctx, f.enc, String(o.format).toUpperCase());
    const out = path.join(ctx.outDir, `${baseName}.${f.ext}`);
    const args = ["-i", input.path, "-vn", "-map", "0:a:0", ...f.codec];
    if (f.lossy) args.push("-b:a", String(o.bitrate));
    args.push(out);
    await ffmpeg(ctx, args, pr.duration, 5, 90, 0, 600_000);
    const st = await fs.stat(out);
    if (tool === "audio-compress" && st.size >= input.size) {
      const keep = path.join(ctx.outDir, `${baseName}.${input.ext}`);
      await fs.rm(out);
      await fs.copyFile(input.path, keep);
      return { outputs: [{ path: keep, name: path.basename(keep) }], meta: { durationSec: pr.duration, keptOriginal: true } };
    }
    return { outputs: [{ path: out, name: path.basename(out) }], meta: { durationSec: pr.duration, codec: f.codec[1], keptOriginal: false } };
  }

  // ---- video -----------------------------------------------------------------------------------
  if (!pr.hasVideo) throw new JobError(`${input.name} has no video track`);
  const fmt = String(o.format);
  const strip = o.stripAudio === true || !pr.hasAudio;

  if (tool === "video-convert" && fmt === "gif") {
    const out = path.join(ctx.outDir, `${baseName}.gif`);
    const secs = Math.min(pr.duration || ctx.cfg.maxGifSeconds, ctx.cfg.maxGifSeconds);
    const cap = o.resolution !== "original" ? RES[String(o.resolution)]! : 480;
    const fc = `fps=12,${capShort(Math.min(cap, 480))},split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
    await ffmpeg(ctx, ["-t", String(secs), "-i", input.path, "-an", "-filter_complex", fc, "-loop", "0", out], secs, 5, 90, 0, 900_000);
    return { outputs: [{ path: out, name: path.basename(out) }], meta: { width: pr.width, height: pr.height, durationSec: pr.duration, codec: "gif", cappedSeconds: pr.duration > secs ? secs : undefined } };
  }

  const profile = tool === "video-compress" ? String(o.profile) : "convert";
  let codec = "h264";
  let crf = 23;
  let preset = "medium";
  let abr = String(o.audioBitrate ?? "128k");
  let container = fmt;
  let vf = EVEN;
  let rss = 0;
  const ultra = pr.width * pr.height > 2560 * 1440 || pr.width > 2560 || pr.bitrate > 35_000_000;
  const resCap = o.resolution !== undefined && o.resolution !== "original" ? RES[String(o.resolution)] : undefined;
  if (tool === "video-convert") {
    codec = fmt === "webm" ? "vp9" : "h264";
    crf = fmt === "webm" ? 32 : 20;
    abr = "160k";
    vf = resCap ? capShort(resCap) : ultra ? GUARD_1080 : EVEN;
  } else if (profile === "quality-safe") {
    crf = 18; abr = "192k"; container = "mp4";
    if (ultra) vf = GUARD_1080;
  } else if (profile === "web-stream") {
    crf = 23; abr = "128k"; container = "mp4"; vf = capShort(720);
  } else if (profile === "av1") {
    // SVT-AV1 needs ~800 MB RSS at 1080p and can't run under RLIMIT_AS: cap at 720p and watch RSS instead.
    codec = "av1"; crf = Number(o.crf) || 28; abr = "128k"; container = "mp4"; vf = capShort(720); preset = "10"; rss = 850;
  } else {
    codec = String(o.codec);
    crf = Number(o.crf);
    vf = resCap ? capShort(resCap) : ultra ? GUARD_1080 : EVEN;
    if (container === "webm" && (codec === "h264" || codec === "h265")) codec = "vp9";
    if (container === "mp4" && codec === "vp9") codec = "h264";
    if (codec === "av1") { vf = capShort(Math.min(720, resCap ?? 720)); preset = "10"; rss = 850; }
  }
  const enc = ({ h264: "libx264", h265: "libx265", vp9: "libvpx-vp9", av1: "libsvtav1" } as Record<string, string>)[codec]!;
  need(ctx, enc, codec.toUpperCase());
  if (!strip) need(ctx, container === "webm" ? "libopus" : "aac", "Audio");

  const srcK = Math.round(pr.audioBitrate / 1000);
  if (srcK > 0 && srcK < (parseInt(abr, 10) || 128)) abr = `${srcK}k`;

  const args = ["-i", input.path, "-map", "0:v:0", ...(strip ? ["-an"] : ["-map", "0:a:0?"]), "-c:v", enc, "-threads", "2", "-filter_threads", "2"];
  if (codec === "h264" || codec === "h265") {
    args.push("-crf", String(crf), "-preset", preset, "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709");
    if (codec === "h265" && container === "mp4") args.push("-tag:v", "hvc1");
    // Never let re-encoding inflate the file: cap at ~92 % of the source bitrate.
    if (pr.bitrate > 0 && tool === "video-compress") {
      const max = Math.round(pr.bitrate * 0.92);
      if (max > 80_000) args.push("-maxrate", String(max), "-bufsize", String(Math.round(max * 1.5)));
    }
  } else if (codec === "vp9") {
    // -b:v 0 combined with -maxrate fails outright in FFmpeg's VP9 encoder: never combine them.
    args.push("-crf", String(crf), "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4");
  } else {
    args.push("-crf", String(crf), "-preset", preset, "-svtav1-params", "lp=1:pin=0");
  }
  args.push("-vf", `${vf},setsar=1`);
  if (!strip) args.push("-c:a", container === "webm" ? "libopus" : "aac", "-b:a", abr);
  if (container === "mp4" || container === "mov") args.push("-movflags", "+faststart");
  const out = path.join(ctx.outDir, `${baseName}.${container}`);
  args.push(out);
  await ffmpeg(ctx, args, pr.duration, 5, 90, rss, 3_600_000);
  const st = await fs.stat(out);
  if (st.size === 0) throw new JobError("Conversion produced an empty file");

  if (tool === "video-compress" && st.size >= input.size) {
    const keep = path.join(ctx.outDir, `${baseName}.${input.ext}`);
    await fs.rm(out);
    await fs.copyFile(input.path, keep);
    return { outputs: [{ path: keep, name: path.basename(keep) }], meta: { width: pr.width, height: pr.height, durationSec: pr.duration, keptOriginal: true } };
  }
  return { outputs: [{ path: out, name: path.basename(out) }], meta: { width: pr.width, height: pr.height, durationSec: pr.duration, codec: enc, profile, keptOriginal: false } };
}
