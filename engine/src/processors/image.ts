/** image-compress / image-convert: decode (native, EXIF-aware) → optional resize → WASM encode → size guard. */
import { EngineError } from "../errors";
import { extOf, formatToExt, mimeOf, outName } from "../formats";
import type { ProcCtx, ProcResult } from "../protocol";
import { bitmapToImageData, flattenOnWhite, hasTransparency, loadImage, resizeBitmap } from "./image-decode";
import { effortOf, encodeAvif, encodeJpeg, encodePng, encodeWebp, type EncodeFormat } from "./image-encode";
import { fitWithin } from "./imageprobe";
import { qualityScore } from "./ssim";

const SSIM_MAX_PIXELS = 36_000_000;

/** Format used when the user asks to keep the input format ("original") — not every input is encodable. */
export function resolveTargetFormat(requested: string, sourceKind: string): { format: EncodeFormat; changed: boolean } {
  if (requested !== "original") return { format: requested as EncodeFormat, changed: true };
  switch (sourceKind) {
    case "jpg":
      return { format: "jpeg", changed: false };
    case "png":
      return { format: "png", changed: false };
    case "webp":
      return { format: "webp", changed: false };
    case "avif":
      return { format: "avif", changed: false };
    case "heic":
      return { format: "jpeg", changed: true };
    default: // bmp, gif: no useful same-format encoder
      return { format: "png", changed: true };
  }
}

const sourceFormatOf = (kind: string): EncodeFormat | null =>
  kind === "jpg" ? "jpeg" : kind === "png" || kind === "webp" || kind === "avif" ? (kind as EncodeFormat) : null;

export async function processImage(ctx: ProcCtx): Promise<ProcResult> {
  const file = ctx.files[0];
  if (!file) throw new EngineError("no-input", "No file selected.");
  const o = ctx.options;
  const quality = Math.max(1, Math.min(100, Number(o.quality ?? (ctx.toolId === "image-compress" ? 75 : 85))));
  const effort = effortOf(o.effort);
  const t0 = performance.now();
  ctx.progress("processing", 3, "Decoding");
  const img = await loadImage(file);
  const tDecode = performance.now();
  const srcW = img.width;
  const srcH = img.height;
  try {
    const { format, changed } = resolveTargetFormat(String(o.format ?? "original"), img.kind);
    const maxW = o.width ? Number(o.width) : undefined;
    const maxH = o.height ? Number(o.height) : undefined;
    const target = fitWithin(srcW, srcH, maxW, maxH);
    const resized = target.width !== srcW || target.height !== srcH;
    let bitmap = img.bitmap;
    if (resized) {
      ctx.progress("processing", 15, "Resizing");
      bitmap = await resizeBitmap(bitmap, target.width, target.height);
    }
    const pixels = bitmapToImageData(bitmap);
    const wantsScore = pixels.width * pixels.height <= SSIM_MAX_PIXELS;
    const smallRef = wantsScore ? await smallLuma(bitmap) : null;
    bitmap.close();
    ctx.progress("processing", 30, "Compressing");

    if (format === "jpeg" && hasTransparency(pixels)) flattenOnWhite(pixels);
    let bytes: Uint8Array;
    switch (format) {
      case "webp":
        bytes = await encodeWebp(pixels, quality, effort);
        break;
      case "avif":
        bytes = await encodeAvif(pixels, quality, effort);
        break;
      case "jpeg":
        bytes = await encodeJpeg(pixels, quality, effort);
        break;
      case "png":
        bytes = await encodePng(pixels, quality, effort);
        break;
      default:
        throw new EngineError("bad-option", `Unsupported output format "${String(format)}".`);
    }
    const tEncode = performance.now();
    ctx.progress("finalizing", 90, "Finishing");

    const ext = formatToExt(format);
    const sameFormat = !changed && sourceFormatOf(img.kind) === format;
    // Never return a larger file than we were given when the format is unchanged and nothing was resized.
    if (sameFormat && !resized && bytes.length >= file.size) {
      return {
        outputs: [{ blob: file.slice(0, file.size, file.type || mimeOf(extOf(file.name))), filename: outName(file.name, extOf(file.name) || ext), mime: mimeOf(ext), size: file.size }],
        meta: {
          width: srcW,
          height: srcH,
          outputWidth: srcW,
          outputHeight: srcH,
          codec: ext,
          keptOriginal: true,
          reason: "Already optimally compressed — the original is smaller than what we could produce.",
          qualityScore: 100,
          timingsMs: { decode: Math.round(tDecode - t0), encode: Math.round(tEncode - tDecode) },
        },
      };
    }

    let score: number | undefined;
    let tScore = 0;
    if (smallRef) {
      const s0 = performance.now();
      score = await scoreOutput(bytes, mimeOf(ext), smallRef).catch(() => undefined);
      tScore = performance.now() - s0;
    }
    const blob = new Blob([bytes as BlobPart], { type: mimeOf(ext) });
    return {
      outputs: [{ blob, filename: outName(file.name, ext), mime: mimeOf(ext), size: blob.size }],
      meta: {
        width: srcW,
        height: srcH,
        outputWidth: pixels.width,
        outputHeight: pixels.height,
        codec: ext,
        keptOriginal: false,
        ...(score !== undefined ? { qualityScore: score } : {}),
        timingsMs: { decode: Math.round(tDecode - t0), encode: Math.round(tEncode - tDecode), score: Math.round(tScore) },
      },
    };
  } finally {
    try {
      img.bitmap.close();
    } catch {
      /* already closed */
    }
  }
}

// ── quality score (cheap SSIM on a ≤256 px luma proxy) ─────────────────────────────────────────

const SMALL = 256;

async function smallLuma(bitmap: ImageBitmap): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const s = Math.min(1, SMALL / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s));
  const h = Math.max(1, Math.round(bitmap.height * s));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingQuality = "medium";
  g.drawImage(bitmap, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h);
  return { data: d.data, width: w, height: h };
}

async function scoreOutput(
  bytes: Uint8Array,
  mime: string,
  ref: { data: Uint8ClampedArray; width: number; height: number },
): Promise<number | undefined> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), {
    resizeWidth: ref.width,
    resizeHeight: ref.height,
    resizeQuality: "medium",
    premultiplyAlpha: "none",
  });
  const c = new OffscreenCanvas(ref.width, ref.height);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const out = g.getImageData(0, 0, ref.width, ref.height);
  return qualityScore(ref, { data: out.data, width: out.width, height: out.height });
}

