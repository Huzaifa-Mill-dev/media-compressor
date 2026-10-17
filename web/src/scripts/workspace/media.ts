import { extOf } from "../../lib/format";

export type MediaKind = "image" | "video" | "audio" | "other";

/** Formats every evergreen browser can render in <img>. HEIC/TIFF deliberately excluded. */
const IMG_EXT = new Set(["png", "jpg", "jpeg", "webp", "avif", "gif", "bmp", "ico"]);
const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mov", "ogv"]);
const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba"]);

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/json": "json",
};

/** Extension from the filename, falling back to the MIME type (e.g. pasted "image.png" blobs). */
export function fileExt(file: { name: string; type: string }): string {
  return extOf(file.name) || MIME_EXT[file.type] || "";
}

export function kindOf(name: string, mime: string): MediaKind {
  const ext = extOf(name) || MIME_EXT[mime] || "";
  if (IMG_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "other";
}

/** Keep two media elements in lock-step (ported from the original side-by-side player). */
export function syncPair(a: HTMLMediaElement, b: HTMLMediaElement, onState?: (playing: boolean) => void): void {
  let syncing = false;
  const guard = (fn: () => void) => {
    if (syncing) return;
    syncing = true;
    fn();
    setTimeout(() => (syncing = false), 150);
  };
  const link = (src: HTMLMediaElement, dst: HTMLMediaElement) => {
    src.addEventListener("play", () => {
      onState?.(true);
      if (dst.paused)
        guard(() => {
          dst.currentTime = src.currentTime;
          dst.play().catch(() => {});
        });
    });
    src.addEventListener("pause", () => {
      onState?.(false);
      if (!dst.paused) guard(() => dst.pause());
    });
    src.addEventListener("seeked", () => {
      if (Math.abs(dst.currentTime - src.currentTime) > 0.1) dst.currentTime = src.currentTime;
    });
  };
  link(a, b);
  link(b, a);
}

export function togglePair(a: HTMLMediaElement, b: HTMLMediaElement): void {
  if (a.paused || b.paused) {
    b.currentTime = a.currentTime;
    a.play().catch(() => {});
    b.play().catch(() => {});
  } else {
    a.pause();
    b.pause();
  }
}
