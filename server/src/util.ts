import path from "node:path";

/** Bidi controls + zero-width characters that can disguise a file name (e.g. "invoice\u202Efdp.exe"). */
const BIDI_AND_INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const RESERVED = /[\\/:*?"<>|%]/g;

/**
 * Make an arbitrary user-supplied file name safe to display and to put in Content-Disposition:
 * keeps only the last path segment, strips control / bidi characters and reserved characters, trims dots,
 * and limits the length (in UTF-8 bytes) while keeping the extension.
 */
export function sanitizeFilename(name: string, fallback = "file", maxBytes = 120): string {
  let s = String(name ?? "");
  s = s.normalize("NFC");
  s = s.replace(CONTROL, "").replace(BIDI_AND_INVISIBLE, "");
  // last path segment (both separator styles)
  s = s.split(/[\\/]/).pop() ?? "";
  s = s.replace(RESERVED, "_").replace(/\s+/g, " ").trim();
  s = s.replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (!s) return fallback;
  const ext = path.extname(s);
  const safeExt = /^\.[A-Za-z0-9]{1,10}$/.test(ext) ? ext : "";
  let base = safeExt ? s.slice(0, -ext.length) : s;
  const enc = new TextEncoder();
  while (base.length > 0 && enc.encode(base + safeExt).length > maxBytes) base = Array.from(base).slice(0, -1).join("");
  base = base.replace(/[. ]+$/, "");
  return (base || fallback) + safeExt;
}

/** Name without extension, sanitized. */
export function safeBaseName(name: string, fallback = "file"): string {
  const s = sanitizeFilename(name, fallback);
  const ext = path.extname(s);
  const base = ext ? s.slice(0, -ext.length) : s;
  return base || fallback;
}

/** Lower-case extension of an uploaded name without the dot; "" if absent or not [a-z0-9]{1,10}. */
export function extOf(name: string): string {
  const ext = path.extname(String(name ?? "")).slice(1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

/** RFC 6266 / RFC 5987 Content-Disposition with an ASCII fallback and UTF-8 `filename*`. */
export function contentDisposition(rawName: string, type: "attachment" | "inline" = "attachment"): string {
  const name = sanitizeFilename(rawName, "download");
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const star = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  tif: "image/tiff",
  tiff: "image/tiff",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  rtf: "application/rtf",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  html: "text/html; charset=utf-8",
  zip: "application/zip",
};

export function mimeForExt(ext: string): string {
  return MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
