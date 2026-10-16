/**
 * Magic-byte sniffing. The extension picks the rule; the content must agree. Anything that does not
 * match is rejected, so a PNG renamed `.pdf` or an HTML page renamed `.docx` never reaches ffmpeg,
 * Ghostscript or LibreOffice.
 */
import fs from "node:fs/promises";
import { badRequest } from "./errors.js";

const HEAD_BYTES = 64 * 1024;
/** Upper bound for the unpacked size of a ZIP-based office file (zip-bomb guard). */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 20_000;
const MAX_CENTRAL_DIR = 8 * 1024 * 1024;

const ascii = (b: Buffer, off: number, len: number) => b.subarray(off, off + len).toString("latin1");
const startsWith = (b: Buffer, sig: number[], off = 0) => b.length >= off + sig.length && sig.every((v, i) => b[off + i] === v);

const isRiff = (b: Buffer, kind: string) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, kind.length) === kind;
const isFtyp = (b: Buffer) => b.length >= 12 && ascii(b, 4, 4) === "ftyp";
const isEbml = (b: Buffer) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]);
const isOle = (b: Buffer) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const isZip = (b: Buffer) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]);
const isMp3 = (b: Buffer) => ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0);
const isAdts = (b: Buffer) => ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xf6) === 0xf0);
const isMovLike = (b: Buffer) => isFtyp(b) || ["moov", "mdat", "free", "wide", "skip", "pnot"].includes(ascii(b, 4, 4));
const isSfnt = (b: Buffer) => startsWith(b, [0, 1, 0, 0]) || ascii(b, 0, 4) === "true" || ascii(b, 0, 4) === "OTTO";

/** Text formats: no NUL bytes and not mostly control characters (UTF-16 with BOM is allowed). */
function looksLikeText(b: Buffer): boolean {
  if (b.length === 0) return false;
  const utf16 = (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);
  let ctrl = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    if (c === 0) {
      if (utf16) continue;
      return false;
    }
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) ctrl++;
  }
  return ctrl / b.length < 0.05;
}

type Rule = (head: Buffer) => boolean;
const RULES: Record<string, Rule> = {
  // images
  jpg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  jpeg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  png: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  gif: (b) => ascii(b, 0, 4) === "GIF8",
  webp: (b) => isRiff(b, "WEBP") && ascii(b, 8, 4) === "WEBP",
  avif: (b) => isFtyp(b) && /avif|avis|mif1|msf1/.test(ascii(b, 8, 32)),
  heic: (b) => isFtyp(b),
  heif: (b) => isFtyp(b),
  bmp: (b) => ascii(b, 0, 2) === "BM",
  tif: (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]),
  tiff: (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]),
  // video
  mp4: isFtyp,
  m4v: isFtyp,
  "3gp": isFtyp,
  mov: isMovLike,
  webm: isEbml,
  mkv: isEbml,
  avi: (b) => isRiff(b, "AVI "),
  ogv: (b) => ascii(b, 0, 4) === "OggS",
  // audio
  mp3: isMp3,
  aac: isAdts,
  wav: (b) => isRiff(b, "WAVE"),
  m4a: isFtyp,
  ogg: (b) => ascii(b, 0, 4) === "OggS",
  oga: (b) => ascii(b, 0, 4) === "OggS",
  opus: (b) => ascii(b, 0, 4) === "OggS",
  flac: (b) => ascii(b, 0, 4) === "fLaC",
  weba: isEbml,
  // fonts
  ttf: isSfnt,
  otf: isSfnt,
  woff: (b) => ascii(b, 0, 4) === "wOFF",
  woff2: (b) => ascii(b, 0, 4) === "wOF2",
  // documents
  pdf: (b) => b.subarray(0, 1024).includes("%PDF-"),
  doc: isOle,
  ppt: isOle,
  xls: isOle,
  docx: isZip,
  pptx: isZip,
  xlsx: isZip,
  odt: isZip,
  odp: isZip,
  ods: isZip,
  rtf: (b) => ascii(b, 0, 5) === "{\\rtf",
  txt: looksLikeText,
  csv: looksLikeText,
  html: looksLikeText,
  htm: looksLikeText,
};

/** For ZIP-based formats, the central directory must contain these entries (and `mimetype` for ODF). */
const ZIP_MARKERS: Record<string, { entry?: string; mimetype?: string }> = {
  docx: { entry: "word/document.xml" },
  pptx: { entry: "ppt/presentation.xml" },
  xlsx: { entry: "xl/workbook.xml" },
  odt: { mimetype: "application/vnd.oasis.opendocument.text" },
  ods: { mimetype: "application/vnd.oasis.opendocument.spreadsheet" },
  odp: { mimetype: "application/vnd.oasis.opendocument.presentation" },
};

async function readAt(fh: fs.FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

async function checkZip(fh: fs.FileHandle, size: number, ext: string, label: string): Promise<void> {
  const marker = ZIP_MARKERS[ext]!;
  const bad = (why: string) => badRequest(`${label} is not a valid .${ext} file (${why})`);
  const tailLen = Math.min(size, 65_557);
  const tail = await readAt(fh, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad("corrupt or truncated archive");
  const entries = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw bad("unsupported ZIP64 archive");
  if (entries === 0 || entries > MAX_ZIP_ENTRIES) throw bad("unexpected number of entries");
  if (cdSize > MAX_CENTRAL_DIR || cdOffset + cdSize > size) throw bad("corrupt archive directory");
  const cd = await readAt(fh, cdOffset, cdSize);
  let pos = 0;
  let total = 0;
  let found = false;
  let mimetypeOffset = -1;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== 0x02014b50) throw bad("corrupt archive directory");
    const uncompressed = cd.readUInt32LE(pos + 24);
    const nameLen = cd.readUInt16LE(pos + 28);
    const extraLen = cd.readUInt16LE(pos + 30);
    const commentLen = cd.readUInt16LE(pos + 32);
    const localOffset = cd.readUInt32LE(pos + 42);
    const name = cd.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    total += uncompressed;
    if (total > MAX_UNPACKED_BYTES) throw bad("archive expands to an unreasonable size");
    if (marker.entry && name === marker.entry) found = true;
    if (marker.mimetype && name === "mimetype") mimetypeOffset = localOffset;
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (marker.entry && !found) throw bad("missing required document parts");
  if (marker.mimetype) {
    if (mimetypeOffset < 0) throw bad("missing mimetype entry");
    const lh = await readAt(fh, mimetypeOffset, 30);
    if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw bad("corrupt archive");
    const data = await readAt(fh, mimetypeOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28), 96);
    if (!data.toString("latin1").startsWith(marker.mimetype)) throw bad("wrong OpenDocument type");
  }
}

/** Throws HttpError(400) unless the file's content matches its extension. */
export async function sniffFile(filePath: string, ext: string, size: number, label: string): Promise<void> {
  if (size === 0) throw badRequest(`${label} is empty`);
  const rule = RULES[ext];
  if (!rule) throw badRequest(`${label}: unsupported file type .${ext}`);
  const fh = await fs.open(filePath, "r");
  try {
    const head = await readAt(fh, 0, Math.min(size, HEAD_BYTES));
    if (!rule(head)) throw badRequest(`${label} does not look like a .${ext} file (content does not match its extension)`);
    if (Object.hasOwn(ZIP_MARKERS, ext)) await checkZip(fh, size, ext, label);
  } finally {
    await fh.close();
  }
}
