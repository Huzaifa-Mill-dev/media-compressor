/** ffmpeg.wasm command lines (pure; node-testable). Mirrors the server's profiles where the core allows. */
import { EngineError } from "../errors";
import type { Options, ToolId } from "../types";
import { audioFormatOf, planVideo } from "./media-plan";

const scaleFilter = (capShort?: number) =>
  capShort
    ? `scale='if(gt(iw,ih),-2,min(${capShort},iw))':'if(gt(iw,ih),min(${capShort},ih),-2)'`
    : "scale=trunc(iw/2)*2:trunc(ih/2)*2";

export function ffmpegArgs(toolId: ToolId, o: Options, input: string, output: string, outExt: string): string[] {
  const base = ["-hide_banner", "-y", "-i", input];
  if (toolId === "video-convert" && outExt === "gif") {
    const cap = Math.min(480, ({ "480p": 480, "720p": 720, "1080p": 1080, "1440p": 1440 } as Record<string, number>)[String(o.resolution)] ?? 480);
    return [
      ...base,
      "-an",
      "-vf",
      `fps=12,scale='if(gt(iw,ih),-2,min(${cap},iw))':'if(gt(iw,ih),min(${cap},ih),-2)':flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
      "-loop",
      "0",
      output,
    ];
  }
  if (toolId === "video-to-audio" || toolId === "audio-convert" || toolId === "audio-compress") {
    const { format, bps } = audioFormatOf(toolId, o);
    const k = `${Math.round(bps / 1000)}k`;
    const codec: string[] =
      format === "mp3" ? ["-c:a", "libmp3lame", "-b:a", k] : format === "m4a" ? ["-c:a", "aac", "-b:a", k] : format === "wav" ? ["-c:a", "pcm_s16le"] : format === "flac" ? ["-c:a", "flac"] : ["-c:a", "libopus", "-b:a", k];
    return [...base, "-vn", ...codec, output];
  }
  const plan = planVideo(toolId, o);
  if (plan.profile === "av1" || plan.codecs[0] === "av1") {
    throw new EngineError("browser-unsupported", "AV1 encoding isn't available in the fallback encoder.");
  }
  const a = plan.stripAudio ? ["-an"] : ["-c:a", plan.container === "webm" ? "libopus" : "aac", "-b:a", `${Math.round(plan.audioBps / 1000)}k`];
  const vf = ["-vf", scaleFilter(plan.capShort)];
  if (plan.container === "webm" || plan.codecs[0] === "vp9") {
    return [...base, "-c:v", "libvpx-vp9", "-crf", String(plan.crf + 6), "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "5", ...vf, ...a, output];
  }
  return [
    ...base,
    "-c:v",
    plan.codecs[0] === "hevc" ? "libx265" : "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(plan.crf),
    "-pix_fmt",
    "yuv420p",
    ...vf,
    ...a,
    ...(plan.container === "mp4" || plan.container === "mov" ? ["-movflags", "+faststart"] : []),
    output,
  ];
}
