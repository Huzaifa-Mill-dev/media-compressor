/**
 * WOFF 1.0 encoder/decoder (https://www.w3.org/TR/WOFF/), plus sfnt helpers. Pure; node-testable.
 * Per-table zlib compression via fflate; tables stored uncompressed when compression doesn't help.
 */
import { unzlibSync, zlibSync } from "fflate";

export interface SfntTable {
  tag: string;
  checksum: number;
  data: Uint8Array;
}

export interface Sfnt {
  flavor: number;
  tables: SfntTable[];
}

const pad4 = (n: number) => (n + 3) & ~3;

function tagStr(dv: DataView, off: number): string {
  return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
}

function writeTag(dv: DataView, off: number, tag: string) {
  for (let i = 0; i < 4; i++) dv.setUint8(off + i, tag.charCodeAt(i) & 0xff);
}

/** OpenType table checksum (sum of big-endian uint32, zero-padded). */
export function calcChecksum(data: Uint8Array): number {
  let sum = 0;
  const n = data.length;
  const full = n & ~3;
  for (let i = 0; i < full; i += 4) {
    sum = (sum + ((data[i]! << 24) | (data[i + 1]! << 16) | (data[i + 2]! << 8) | data[i + 3]!)) >>> 0;
  }
  if (full < n) {
    let last = 0;
    for (let i = 0; i < 4; i++) last = (last << 8) | (full + i < n ? data[full + i]! : 0);
    sum = (sum + (last >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

function headChecksum(data: Uint8Array): number {
  // head.checkSumAdjustment (offset 8) is treated as zero when computing the head checksum.
  const copy = data.slice();
  if (copy.length >= 12) copy.fill(0, 8, 12);
  return calcChecksum(copy);
}

export function parseSfnt(buf: Uint8Array): Sfnt {
  if (buf.length < 12) throw new Error("Not a valid font: file is too short.");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flavor = dv.getUint32(0);
  if (flavor !== 0x00010000 && flavor !== 0x4f54544f && flavor !== 0x74727565) {
    throw new Error("Not a valid TrueType/OpenType font (bad sfnt version).");
  }
  const numTables = dv.getUint16(4);
  if (numTables === 0 || numTables > 1000) throw new Error("Not a valid font: bad table count.");
  if (12 + numTables * 16 > buf.length) throw new Error("Font is truncated (table directory incomplete).");
  const tables: SfntTable[] = [];
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    const tag = tagStr(dv, p);
    const checksum = dv.getUint32(p + 4);
    const offset = dv.getUint32(p + 8);
    const length = dv.getUint32(p + 12);
    if (offset + length > buf.length) throw new Error(`Font is truncated (table '${tag}' extends past end of file).`);
    tables.push({ tag, checksum, data: buf.subarray(offset, offset + length) });
  }
  return { flavor, tables };
}

/** Serialise an sfnt, recomputing table checksums and head.checkSumAdjustment. */
export function buildSfnt(font: Sfnt): Uint8Array {
  const tables = [...font.tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const n = tables.length;
  const headerSize = 12 + 16 * n;
  let size = headerSize;
  for (const t of tables) size += pad4(t.data.length);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let es = 0;
  while (1 << (es + 1) <= n) es++;
  const searchRange = (1 << es) * 16;
  dv.setUint32(0, font.flavor);
  dv.setUint16(4, n);
  dv.setUint16(6, searchRange);
  dv.setUint16(8, es);
  dv.setUint16(10, n * 16 - searchRange);
  let off = headerSize;
  let headOffset = -1;
  tables.forEach((t, i) => {
    const data = t.data;
    const p = 12 + i * 16;
    writeTag(dv, p, t.tag);
    out.set(data, off);
    if (t.tag === "head" && data.length >= 12) {
      headOffset = off;
      out.fill(0, off + 8, off + 12);
    }
    dv.setUint32(p + 4, t.tag === "head" ? headChecksum(out.subarray(off, off + data.length)) : calcChecksum(data));
    dv.setUint32(p + 8, off);
    dv.setUint32(p + 12, data.length);
    off += pad4(data.length);
  });
  if (headOffset >= 0) {
    const adj = (0xb1b0afba - calcChecksum(out)) >>> 0;
    dv.setUint32(headOffset + 8, adj);
  }
  return out;
}

export function isWoff(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x77 && buf[1] === 0x4f && buf[2] === 0x46 && buf[3] === 0x46;
}

export function encodeWoff(sfntBytes: Uint8Array, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 9): Uint8Array {
  const font = parseSfnt(sfntBytes);
  const tables = [...font.tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const n = tables.length;
  const encoded = tables.map((t) => {
    const comp = zlibSync(t.data, { level });
    const useComp = comp.length < t.data.length;
    return {
      tag: t.tag,
      origLength: t.data.length,
      checksum: t.tag === "head" ? headChecksum(t.data) : calcChecksum(t.data),
      stored: useComp ? comp : t.data,
    };
  });
  let totalSfntSize = 12 + 16 * n;
  for (const t of encoded) totalSfntSize += pad4(t.origLength);
  let length = 44 + 20 * n;
  for (const t of encoded) length += pad4(t.stored.length);
  const out = new Uint8Array(length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x774f4646); // 'wOFF'
  dv.setUint32(4, font.flavor);
  dv.setUint32(8, length);
  dv.setUint16(12, n);
  dv.setUint16(14, 0);
  dv.setUint32(16, totalSfntSize);
  // major/minor version: copy from head.fontRevision if present (informational), else 1.0
  const head = tables.find((t) => t.tag === "head");
  if (head && head.data.length >= 8) {
    const hdv = new DataView(head.data.buffer, head.data.byteOffset, head.data.byteLength);
    dv.setUint16(20, hdv.getUint16(4));
    dv.setUint16(22, hdv.getUint16(6));
  } else {
    dv.setUint16(20, 1);
    dv.setUint16(22, 0);
  }
  // metadata/private blocks: none (offsets/lengths 0)
  let off = 44 + 20 * n;
  encoded.forEach((t, i) => {
    const p = 44 + i * 20;
    writeTag(dv, p, t.tag);
    dv.setUint32(p + 4, off);
    dv.setUint32(p + 8, t.stored.length);
    dv.setUint32(p + 12, t.origLength);
    dv.setUint32(p + 16, t.checksum);
    out.set(t.stored, off);
    off += pad4(t.stored.length);
  });
  return out;
}

export function decodeWoff(buf: Uint8Array): Uint8Array {
  if (!isWoff(buf)) throw new Error("Not a WOFF file.");
  if (buf.length < 44) throw new Error("WOFF file is truncated (header incomplete).");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flavor = dv.getUint32(4);
  const length = dv.getUint32(8);
  if (length > buf.length) throw new Error("WOFF file is truncated.");
  const n = dv.getUint16(12);
  if (n === 0 || 44 + n * 20 > buf.length) throw new Error("WOFF file is truncated (table directory incomplete).");
  const tables: SfntTable[] = [];
  for (let i = 0; i < n; i++) {
    const p = 44 + i * 20;
    const tag = tagStr(dv, p);
    const offset = dv.getUint32(p + 4);
    const compLength = dv.getUint32(p + 8);
    const origLength = dv.getUint32(p + 12);
    const checksum = dv.getUint32(p + 16);
    if (offset + compLength > buf.length) throw new Error(`WOFF file is truncated (table '${tag}').`);
    if (compLength > origLength) throw new Error(`Invalid WOFF: table '${tag}' compLength > origLength.`);
    const raw = buf.subarray(offset, offset + compLength);
    let data: Uint8Array;
    if (compLength === origLength) data = raw;
    else {
      try {
        data = unzlibSync(raw, { out: new Uint8Array(origLength) });
      } catch {
        throw new Error(`Invalid WOFF: table '${tag}' failed to decompress.`);
      }
      if (data.length !== origLength) throw new Error(`Invalid WOFF: table '${tag}' has wrong decompressed size.`);
    }
    tables.push({ tag, checksum, data });
  }
  return buildSfnt({ flavor, tables });
}
