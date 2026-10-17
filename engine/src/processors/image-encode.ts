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
  const buf = await encode(img, { quality, method, alpha_quality: 100 });
  return new Uint8Array(buf);
}

export async function encodeAvif(img: ImageData, quality: number, effort: Effort): Promise<Uint8Array> {
  const { default: encode } = await import("@jsquash/avif/encode.js");
  const speed = effort === "fast" ? 9 : effort === "best" ? 5 : 7;
  const buf = await encode(img, { quality, speed, qualityAlpha: -1 });
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
    q.setQuality(0, Math.max(1, Math.min(100, quality)));
    q.setSpeed(effort === "fast" ? 8 : effort === "best" ? 3 : 5);
    const rgba = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    const res = q.quantizeImage(rgba, img.width, img.height);
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
