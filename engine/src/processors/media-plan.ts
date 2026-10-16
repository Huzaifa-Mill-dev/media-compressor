/** Pure media planning: profile → container/codec preferences, sizes and bitrates. Node-testable. */
import type { Options, ToolId } from "../types";

export type Container = "mp4" | "webm" | "mov" | "mkv";
export type VCodec = "avc" | "hevc" | "vp9" | "vp8" | "av1";
export type AudioFormat = "mp3" | "m4a" | "ogg" | "opus" | "wav" | "flac";

export interface VideoPlan {
  container: Container;
  /** Codec preference order (first encodable wins). */
  codecs: VCodec[];
  /** Cap on the SHORTER side in px (720 ⇒ "720p" for landscape and portrait alike). */
  capShort?: number;
  /** Target bits per pixel per frame (H.264-equivalent); scaled per codec. */
  bpp: number;
  audioBps: number;
  stripAudio: boolean;
  crf: number;
  profile: string;
  /** True if the user asked for AV1 and we may need to fall back. */
  wantsAv1: boolean;
}

const RES: Record<string, number> = { "480p": 480, "720p": 720, "1080p": 1080, "1440p": 1440 };
const CODEC_FROM_OPTION: Record<string, VCodec> = { h264: "avc", h265: "hevc", vp9: "vp9", av1: "av1" };
/** Relative bitrate needed for equal quality vs H.264. */
export const CODEC_EFFICIENCY: Record<VCodec, number> = { avc: 1, hevc: 0.7, vp9: 0.75, vp8: 1.15, av1: 0.55 };

export const parseBitrate = (v: unknown, fallbackKbps: number): number => {
  const m = /^(\d+)k?$/i.exec(String(v ?? ""));
  return (m ? Number(m[1]) : fallbackKbps) * 1000;
};

/** CRF → bits-per-pixel for H.264 (each +6 CRF roughly halves the bitrate; CRF 18 ≈ 0.10 bpp). */
export const bppFromCrf = (crf: number): number => 0.1 * Math.pow(2, (18 - crf) / 6);

export function planVideo(toolId: ToolId, o: Options): VideoPlan {
  const stripAudio = o.stripAudio === true;
  if (toolId === "video-convert") {
    const container = (["mp4", "webm", "mov", "mkv"].includes(String(o.format)) ? String(o.format) : "mp4") as Container;
    return {
      container,
      codecs: container === "webm" ? ["vp9", "vp8", "av1"] : ["avc", "hevc", "vp9", "av1"],
      capShort: RES[String(o.resolution ?? "original")],
      bpp: bppFromCrf(20),
      audioBps: 160_000,
      stripAudio,
      crf: 20,
      profile: "convert",
      wantsAv1: false,
    };
  }
  const profile = String(o.profile ?? "quality-safe");
  switch (profile) {
    case "web-stream":
      return { container: "mp4", codecs: ["avc", "hevc", "vp9", "av1"], capShort: 720, bpp: bppFromCrf(23), audioBps: 96_000, stripAudio, crf: 23, profile, wantsAv1: false };
    case "av1":
      return { container: "mp4", codecs: ["av1", "avc", "vp9"], bpp: bppFromCrf(28), audioBps: 128_000, stripAudio, crf: 28, profile, wantsAv1: true };
    case "custom": {
      const container = (String(o.format) === "webm" ? "webm" : "mp4") as Container;
      let codec = CODEC_FROM_OPTION[String(o.codec ?? "h264")] ?? "avc";
      // WebM can only hold VP8/VP9/AV1.
      if (container === "webm" && (codec === "avc" || codec === "hevc")) codec = "vp9";
      const crf = Number(o.crf ?? 23);
      const rest = (["avc", "hevc", "vp9", "av1"] as VCodec[]).filter((c) => c !== codec && (container === "mp4" || c === "vp9" || c === "av1"));
      return {
        container,
        codecs: [codec, ...rest],
        capShort: RES[String(o.resolution ?? "original")],
        bpp: bppFromCrf(crf),
        audioBps: parseBitrate(o.audioBitrate, 128),
        stripAudio,
        crf,
        profile,
        wantsAv1: codec === "av1",
      };
    }
    default:
      return { container: "mp4", codecs: ["avc", "hevc", "vp9", "av1"], bpp: bppFromCrf(18), audioBps: 160_000, stripAudio, crf: 18, profile: "quality-safe", wantsAv1: false };
  }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Output dimensions: cap the shorter side, never upscale, always even. */
export function targetSize(w: number, h: number, capShort?: number): { width: number; height: number; scaled: boolean } {
  let s = 1;
  if (capShort && Math.min(w, h) > capShort) s = capShort / Math.min(w, h);
  const width = even(w * s);
  const height = even(h * s);
  return { width, height, scaled: width !== w || height !== h };
}

export function targetVideoBitrate(opts: {
  width: number;
  height: number;
  fps: number;
  bpp: number;
  codec: VCodec;
  /** Source video bitrate, if known: the output never targets more than this. */
  sourceBps?: number;
}): number {
  const raw = opts.width * opts.height * Math.min(opts.fps || 30, 60) * opts.bpp * CODEC_EFFICIENCY[opts.codec];
  const capped = opts.sourceBps && opts.sourceBps > 0 ? Math.min(raw, opts.sourceBps) : raw;
  return Math.round(Math.max(150_000, capped));
}

export function audioFormatOf(toolId: ToolId, o: Options): { format: AudioFormat; bps: number } {
  const format = (["mp3", "m4a", "ogg", "opus", "wav", "flac"].includes(String(o.format)) ? String(o.format) : "mp3") as AudioFormat;
  return { format, bps: parseBitrate(o.bitrate, toolId === "audio-compress" ? 96 : 192) };
}

export const isLossless = (f: AudioFormat) => f === "wav" || f === "flac";
