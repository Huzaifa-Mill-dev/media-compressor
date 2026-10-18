/** Lazy wrappers around the WASM image encoders. Each codec is imported on first use and cached per worker. */
import { EngineError } from "../errors";

export type Effort = "fast" | "balanced" | "best";
export type EncodeFormat = "jpeg" | "png" | "webp" | "avif";

export const effortOf = (v: unknown): Effort => (v === "fast" || v === "best" ? v : "balanced");

export async function encodeWebp(img: ImageData, quality: number, effort: Effort): Promise<Uint8Array> {
  if (img.width > 16383 || img.height > 16383) {
    throw new EngineError("too-large", "WebP supports images up to 16383 px per side. Resize the image or choose another format.");
  }
  const { default: encode } = await import("@jsquash/webp/encode.js");
  const method = effort === "fast" ? 2 : effort === "best" ? 6 : 4;
  // sharp YUV conversion keeps coloured edges (text, logos, UI) crisp at the same size.
  const buf = await encode(img, { quality, method, alpha_quality: 100, use_sharp_yuv: 1 });
  return new Uint8Array(buf);
}

/**
 * The shared 1–100 "quality" means the same visual quality for every format. libavif reaches a given look at much
 * lower numbers than WebP/JPEG (AVIF ~65 ≈ JPEG/WebP ~85), so it is rescaled; at high quality chroma is kept at full
 * resolution (4:4:4) so coloured edges and text stay sharp.
 */
export const avifQuality = (q: number): number => Math.max(1, Math.min(100, Math.round(q * 0.76)));

export async function encodeAvif(img: ImageData, quality: number, effort: Effort): Promise<Uint8Array> {
  const { default: encode } = await import("@jsquash/avif/encode.js");
  const speed = effort === "fast" ? 9 : effort === "best" ? 5 : 7;
  const buf = await encode(img, { quality: avifQuality(quality), speed, qualityAlpha: -1, subsample: quality >= 80 ? 3 : 1 });
  return new Uint8Array(buf);
}

export async function encodeJpeg(img: ImageData, quality: number, effort: Effort): Promise<Uint8Array> {
  const { default: encode } = await import("@jsquash/jpeg/encode.js");
  const buf = await encode(img, {
    quality,
    progressive: true,
    optimize_coding: true,
    trellis_multipass: effort === "best",
    trellis_opt_zero: effort === "best",
    trellis_opt_table: effort === "best",
    trellis_loops: effort === "best" ? 2 : 1,
    auto_subsample: true,
  });
  return new Uint8Array(buf);
}

let iq: Promise<typeof import("libimagequant-wasm/wasm/libimagequant_wasm.js")> | null = null;
async function loadQuantizer() {
  iq ??= (async () => {
    const mod = await import("libimagequant-wasm/wasm/libimagequant_wasm.js");
    const url = (await import("libimagequant-wasm/wasm/libimagequant_wasm_bg.wasm?url")).default;
    await mod.default({ module_or_path: url });
    return mod;
  })();
  try {
    return await iq;
  } catch (e) {
    iq = null;
    throw e;
  }
}

/**
 * Lossy PNG: quantise to ≤256 colours (libimagequant, as used by pngquant/TinyPNG-style tools) and
 * write an indexed PNG. Returns null if quantisation isn't worthwhile/possible.
 */
export async function quantizeToIndexedPng(img: ImageData, quality: number, effort: Effort): Promise<Uint8Array | null> {
  const mod = await loadQuantizer();
  const q = new mod.ImageQuantizer();
  try {
    q.setMaxColors(256);
    // Only accept a palette that stays close to the target; otherwise the caller falls back to lossless PNG
    // (photos/gradients would band).
    const max = Math.max(1, Math.min(100, quality));
    q.setQuality(Math.max(0, max - 15), max);
    q.setSpeed(effort === "fast" ? 8 : effort === "best" ? 3 : 5);
    const rgba = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    let res: ReturnType<typeof q.quantizeImage>;
    try {
      res = q.quantizeImage(rgba, img.width, img.height);
    } catch {
      return null; // quality would drop below the floor
    }
    try {
      res.setDithering(1.0);
      const indices = res.getPaletteIndices(rgba, img.width, img.height);
      const palette = res.getPalette();
      return mod.encode_palette_to_png(indices, palette, img.width, img.height);
    } finally {
      res.free();
    }
  } finally {
    q.free();
  }
}

/** Lossless PNG optimisation (oxipng). Accepts encoded PNG bytes. Auto-reduces to a palette when ≤256 colours. */
export async function oxipngOptimise(png: Uint8Array, effort: Effort): Promise<Uint8Array> {
  const { default: optimise } = await import("@jsquash/oxipng/optimise.js");
  const ab = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
  const out = await optimise(ab, { level: effort === "fast" ? 1 : effort === "best" ? 4 : 2, interlace: false, optimiseAlpha: true });
  return new Uint8Array(out);
}

export async function encodePngRaw(img: ImageData): Promise<Uint8Array> {
  const { default: encode } = await import("@jsquash/png/encode.js");
  return new Uint8Array(await encode(img));
}

export async function encodePng(img: ImageData, quality: number, effort: Effort): Promise<Uint8Array> {
  let png: Uint8Array | null = null;
  if (quality < 100) png = await quantizeToIndexedPng(img, quality, effort);
  png ??= await encodePngRaw(img);
  const opt = await oxipngOptimise(png, effort);
  return opt.length < png.length ? opt : png;
}
