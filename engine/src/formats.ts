/** File-format helpers: extensions, MIME types, magic-byte sniffing. Pure; safe in node, page and workers. */

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  ogv: "video/ogg",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  weba: "audio/webm",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  pdf: "application/pdf",
  csv: "text/csv",
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  txt: "text/plain",
  html: "text/html",
  zip: "application/zip",
};

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

export function baseName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf(".");
  return i <= 0 ? base : base.slice(0, i);
}

export function mimeOf(ext: string): string {
  return MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

/** Normalises user-facing format values to file extensions ("jpeg" → "jpg"). */
export function formatToExt(format: string): string {
  const f = format.toLowerCase();
  if (f === "jpeg") return "jpg";
  if (f === "tiff") return "tif";
  return f;
}

/** Sanitises a name for downloads: strips path parts/control chars, keeps it short. */
export function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_").replace(/^\.+/, "").trim();
  return (cleaned || "file").slice(0, 180);
}

export function outName(inputName: string, ext: string, suffix = ""): string {
  return safeName(`${baseName(inputName)}${suffix}.${ext}`);
}

/** Identify a container/format from its first bytes (≥ 16 bytes recommended). */
export function sniff(head: Uint8Array): string | null {
  const b = head;
  const at = (i: number) => b[i] ?? -1;
  const ascii = (start: number, s: string) => {
    for (let i = 0; i < s.length; i++) if (at(start + i) !== s.charCodeAt(i)) return false;
    return true;
  };
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpg";
  if (ascii(0, "\x89PNG\r\n\x1a\n")) return "png";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "gif";
  if (ascii(0, "BM")) return "bmp";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "wav";
  if (ascii(0, "RIFF") && ascii(8, "AVI ")) return "avi";
  if (ascii(4, "ftyp")) {
    const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
    if (brand === "qt  ") return "mov";
    if (brand.startsWith("M4A")) return "m4a";
    if (brand.startsWith("3g")) return "3gp";
    return "mp4";
  }
  if (ascii(4, "moov") || ascii(4, "mdat") || ascii(4, "wide") || ascii(4, "free")) return "mov";
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return "webm"; // EBML (webm/mkv)
  if (ascii(0, "OggS")) return "ogg";
  if (ascii(0, "fLaC")) return "flac";
  if (ascii(0, "ID3") || (at(0) === 0xff && (at(1) & 0xe0) === 0xe0 && (at(1) & 0x06) !== 0)) {
    // ADTS AAC uses 0xFFF1/0xFFF9 (layer bits 00); MP3 frames have non-zero layer bits.
    return "mp3";
  }
  if (at(0) === 0xff && (at(1) & 0xf6) === 0xf0) return "aac";
  if (ascii(0, "%PDF-")) return "pdf";
  if (ascii(0, "wOFF")) return "woff";
  if (ascii(0, "wOF2")) return "woff2";
  if (ascii(0, "OTTO")) return "otf";
  if ((at(0) === 0 && at(1) === 1 && at(2) === 0 && at(3) === 0) || ascii(0, "true")) return "ttf";
  if (ascii(0, "ttcf")) return "ttc";
  if (ascii(0, "PK\x03\x04")) return "zip";
  if (at(0) === 0xd0 && at(1) === 0xcf && at(2) === 0x11 && at(3) === 0xe0) return "ole"; // xls/doc/ppt
  if ((ascii(0, "II*\0") || ascii(0, "MM\0*"))) return "tif";
  return null;
}

export async function readHead(file: Blob, n = 64): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, n).arrayBuffer());
}

/** Sfnt flavour of a font file: "truetype" | "cff" | null (unknown/unsupported). */
export function fontFlavor(head: Uint8Array): "truetype" | "cff" | null {
  const kind = sniff(head);
  let tag: number;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.byteLength < 8) return null;
  if (kind === "woff" || kind === "woff2") tag = dv.getUint32(4);
  else if (kind === "ttf" || kind === "otf") tag = dv.getUint32(0);
  else return null;
  if (tag === 0x4f54544f) return "cff"; // 'OTTO'
  if (tag === 0x00010000 || tag === 0x74727565) return "truetype"; // 1.0 or 'true'
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}
