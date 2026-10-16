/**
 * Cheap SSIM on downscaled luma. Pure; node-testable.
 * Uses 8×8 non-overlapping windows on box-downscaled luma (≤ 256 px long side),
 * which is fast (~1 ms) and correlates well with full SSIM for compression artefacts.
 */

export interface Rgba {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** Box-downscale RGBA to luma so the longest side is ≤ maxSide. Alpha is composited over white. */
export function lumaDownscale(img: Rgba, maxSide = 256): { y: Float32Array; w: number; h: number } {
  const scale = Math.max(1, Math.max(img.width, img.height) / maxSide);
  const w = Math.max(1, Math.floor(img.width / scale));
  const h = Math.max(1, Math.floor(img.height / scale));
  const y = new Float32Array(w * h);
  const cnt = new Float32Array(w * h);
  const d = img.data;
  // Sample on a grid (stride) to keep it O(output * k) instead of O(input) for huge images.
  const step = Math.max(1, Math.floor(scale / 2));
  for (let sy = 0; sy < img.height; sy += step) {
    const ty = Math.min(h - 1, Math.floor(sy / scale));
    for (let sx = 0; sx < img.width; sx += step) {
      const tx = Math.min(w - 1, Math.floor(sx / scale));
      const i = (sy * img.width + sx) * 4;
      const a = d[i + 3]! / 255;
      const r = d[i]! * a + 255 * (1 - a);
      const g = d[i + 1]! * a + 255 * (1 - a);
      const b = d[i + 2]! * a + 255 * (1 - a);
      const t = ty * w + tx;
      y[t]! += 0.299 * r + 0.587 * g + 0.114 * b;
      cnt[t]! += 1;
    }
  }
  for (let i = 0; i < y.length; i++) y[i] = cnt[i]! > 0 ? y[i]! / cnt[i]! : 0;
  return { y, w, h };
}

export function ssimLuma(a: Float32Array, b: Float32Array, w: number, h: number, win = 8): number {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let total = 0;
  let n = 0;
  const ws = Math.min(win, w, h);
  for (let by = 0; by + ws <= h; by += ws) {
    for (let bx = 0; bx + ws <= w; bx += ws) {
      let ma = 0,
        mb = 0;
      for (let y = by; y < by + ws; y++)
        for (let x = bx; x < bx + ws; x++) {
          ma += a[y * w + x]!;
          mb += b[y * w + x]!;
        }
      const N = ws * ws;
      ma /= N;
      mb /= N;
      let va = 0,
        vb = 0,
        cov = 0;
      for (let y = by; y < by + ws; y++)
        for (let x = bx; x < bx + ws; x++) {
          const da = a[y * w + x]! - ma;
          const db = b[y * w + x]! - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      va /= N - 1 || 1;
      vb /= N - 1 || 1;
      cov /= N - 1 || 1;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  }
  return n ? total / n : 1;
}

/** 0–100 similarity score between two images of possibly different sizes. */
export function qualityScore(original: Rgba, compressed: Rgba): number {
  const A = lumaDownscale(original, 256);
  const B = lumaDownscale(compressed, 256);
  // Different aspect/size after resize → resample B onto A's grid (nearest).
  let by = B.y;
  if (A.w !== B.w || A.h !== B.h) {
    by = new Float32Array(A.w * A.h);
    for (let y = 0; y < A.h; y++)
      for (let x = 0; x < A.w; x++) {
        const sx = Math.min(B.w - 1, Math.floor((x * B.w) / A.w));
        const sy = Math.min(B.h - 1, Math.floor((y * B.h) / A.h));
        by[y * A.w + x] = B.y[sy * B.w + sx]!;
      }
  }
  const s = ssimLuma(A.y, by, A.w, A.h);
  return Math.max(0, Math.min(100, Math.round(s * 1000) / 10));
}
