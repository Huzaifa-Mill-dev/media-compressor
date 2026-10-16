/** Pure image-header inspection: dimensions, animation, truncation. No decoding. Node-testable. */
import { sniff } from "../formats";

const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const ascii = (b: Uint8Array, o: number, s: string) => {
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
};

export interface Dimensions {
  width: number;
  height: number;
}

/** Read pixel dimensions from the header of png/jpg/webp/gif/bmp/avif/heic. Returns null when unreadable. */
export function probeDimensions(b: Uint8Array, kind = sniff(b)): Dimensions | null {
  try {
    switch (kind) {
      case "png":
        if (b.length < 24) return null;
        return { width: u32be(b, 16), height: u32be(b, 20) };
      case "gif":
        if (b.length < 10) return null;
        return { width: u16le(b, 6), height: u16le(b, 8) };
      case "bmp":
        if (b.length < 26) return null;
        return { width: u32le(b, 18) | 0, height: Math.abs(u32le(b, 22) | 0) };
      case "jpg": {
        let i = 2;
        while (i + 9 < b.length) {
          if (b[i] !== 0xff) {
            i++;
            continue;
          }
          const m = b[i + 1]!;
          if (m === 0xff) {
            i++;
            continue;
          }
          if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
            i += 2;
            continue;
          }
          const len = u16be(b, i + 2);
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
            return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
          }
          i += 2 + len;
        }
        return null;
      }
      case "webp": {
        if (b.length < 30) return null;
        if (ascii(b, 12, "VP8X")) {
          return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
        }
        if (ascii(b, 12, "VP8L")) {
          const bits = u32le(b, 21);
          return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        if (ascii(b, 12, "VP8 ")) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
        return null;
      }
      case "avif":
      case "heic": {
        // Largest 'ispe' (image spatial extents) property found in the first 256 KB (the meta box).
        const end = Math.min(b.length - 12, 256 * 1024);
        let best: Dimensions | null = null;
        for (let i = 4; i < end; i++) {
          if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
            const w = u32be(b, i + 8);
            const h = u32be(b, i + 12);
            if (w > 0 && h > 0 && (!best || w * h > best.width * best.height)) best = { width: w, height: h };
          }
        }
        return best;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** True when the file holds an animation (GIF with >1 frame, APNG, animated WebP, AVIF sequence). */
export function isAnimated(b: Uint8Array, kind = sniff(b)): boolean {
  switch (kind) {
    case "gif": {
      // Walk blocks; count image descriptors.
      if (b.length < 13) return false;
      let i = 13;
      const flags = b[10]!;
      if (flags & 0x80) i += 3 * (1 << ((flags & 7) + 1));
      let frames = 0;
      while (i < b.length) {
        const t = b[i]!;
        if (t === 0x3b) break;
        if (t === 0x2c) {
          frames++;
          if (frames > 1) return true;
          const lf = b[i + 9]!;
          i += 10;
          if (lf & 0x80) i += 3 * (1 << ((lf & 7) + 1));
          i++; // LZW min code size
          while (i < b.length && b[i] !== 0) i += b[i]! + 1;
          i++;
        } else if (t === 0x21) {
          i += 2;
          while (i < b.length && b[i] !== 0) i += b[i]! + 1;
          i++;
        } else return false;
      }
      return false;
    }
    case "png": {
      let i = 8;
      while (i + 8 <= b.length) {
        const len = u32be(b, i);
        if (ascii(b, i + 4, "acTL")) return true;
        if (ascii(b, i + 4, "IDAT")) return false;
        i += 12 + len;
      }
      return false;
    }
    case "webp":
      return b.length > 20 && ascii(b, 12, "VP8X") && (b[20]! & 0x02) !== 0;
    case "avif":
      return ascii(b, 8, "avis");
    default:
      return false;
  }
}

/**
 * Cheap integrity check: does the file end the way a complete file of this type must?
 * `head` = first bytes, `tail` = last ≥ 64 bytes (may equal head for small files), `size` = total length.
 */
export function looksTruncated(head: Uint8Array, tail: Uint8Array, size: number, kind = sniff(head)): boolean {
  switch (kind) {
    case "jpg": {
      // EOI (FFD9) must appear within the last few bytes (some writers pad with zeros).
      for (let i = tail.length - 2; i >= Math.max(0, tail.length - 64); i--) if (tail[i] === 0xff && tail[i + 1] === 0xd9) return false;
      return true;
    }
    case "png": {
      // IEND chunk: length(4) 'IEND' crc(4) — within the last 64 bytes.
      for (let i = tail.length - 8; i >= Math.max(0, tail.length - 64); i--) if (ascii(tail, i, "IEND")) return false;
      return true;
    }
    case "webp":
      return head.length >= 12 && u32le(head, 4) + 8 > size;
    case "gif":
      return tail[tail.length - 1] !== 0x3b;
    default:
      return false;
  }
}

/** Largest size that fits within maxW×maxH, preserving aspect ratio, never upscaling. */
export function fitWithin(w: number, h: number, maxW?: number, maxH?: number): Dimensions {
  let s = 1;
  if (maxW && maxW > 0) s = Math.min(s, maxW / w);
  if (maxH && maxH > 0) s = Math.min(s, maxH / h);
  if (s >= 1) return { width: w, height: h };
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}
