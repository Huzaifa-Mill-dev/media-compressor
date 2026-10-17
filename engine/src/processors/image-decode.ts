/** Decode image files to bitmaps / pixel data inside a worker (or page). Handles EXIF orientation, HEIC, validation. */
import { EngineError } from "../errors";
import { extOf, formatBytes, sniff } from "../formats";
import { MAX_IMAGE_PIXELS } from "../routing";
import { isAnimated, looksTruncated, probeDimensions, type Dimensions } from "./imageprobe";

export interface LoadedImage {
  bitmap: ImageBitmap;
  /** Detected format of the source (png, jpg, webp, avif, gif, bmp, heic). */
  kind: string;
  /** Dimensions after EXIF orientation. */
  width: number;
  height: number;
}

const DECODABLE = new Set(["png", "jpg", "webp", "avif", "gif", "bmp", "heic"]);

/** Validate header/size/animation cheaply (reads ≤ 256 KB, whole file only for GIF). Returns the detected kind. */
export async function inspectImage(file: File): Promise<{ kind: string; dims: Dimensions | null }> {
  if (file.size === 0) throw new EngineError("empty", `${file.name} is empty (0 bytes).`);
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  let kind = sniff(head);
  const ext = extOf(file.name);
  if (kind === null || !DECODABLE.has(kind)) {
    if (ext === "heif") kind = "heic";
    if (kind === null || !DECODABLE.has(kind)) {
      throw new EngineError("corrupt", `${file.name} isn't a valid image (unrecognised file header). It may be corrupt or not an image.`);
    }
  }
  const dims = probeDimensions(head, kind);
  if (dims && (dims.width < 1 || dims.height < 1)) {
    throw new EngineError("corrupt", `${file.name} has invalid dimensions.`);
  }
  if (dims && dims.width * dims.height > MAX_IMAGE_PIXELS) {
    throw new EngineError(
      "too-large",
      `${file.name} is ${dims.width}×${dims.height} (${Math.round((dims.width * dims.height) / 1e6)} MP) — too large to process in the browser (limit ${Math.round(MAX_IMAGE_PIXELS / 1e6)} MP).`,
    );
  }
  const tail = file.size > head.length ? new Uint8Array(await file.slice(Math.max(0, file.size - 128)).arrayBuffer()) : head;
  if (looksTruncated(head, tail, file.size, kind)) {
    throw new EngineError("corrupt", `${file.name} looks truncated or corrupt (the file ends unexpectedly).`);
  }
  if (kind === "gif" || kind === "png" || kind === "webp" || kind === "avif") {
    const full = kind === "gif" && file.size > head.length ? new Uint8Array(await file.arrayBuffer()) : head;
    if (isAnimated(full, kind)) {
      throw new EngineError("browser-unsupported", `${file.name} is animated; animated images can't be converted in the browser without losing frames.`);
    }
  }
  return { kind, dims };
}

export async function loadImage(file: File): Promise<LoadedImage> {
  const { kind } = await inspectImage(file);
  let bitmap: ImageBitmap;
  try {
    if (kind === "heic") {
      const { heicTo } = await import("heic-to");
      bitmap = await heicTo({ blob: file, type: "bitmap", options: { imageOrientation: "from-image" } });
    } else {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image", premultiplyAlpha: "none", colorSpaceConversion: "default" });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new EngineError(
      "corrupt",
      `Couldn't decode ${file.name} (${formatBytes(file.size)}): the file may be corrupt, truncated or in an unsupported variant.${msg ? ` [${msg.slice(0, 120)}]` : ""}`,
    );
  }
  if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
    bitmap.close();
    throw new EngineError("too-large", `${file.name} is too large to process in the browser.`);
  }
  return { bitmap, kind, width: bitmap.width, height: bitmap.height };
}

/** Downscale a bitmap with high-quality resampling; closes the input when a new bitmap is produced. */
export async function resizeBitmap(bitmap: ImageBitmap, width: number, height: number): Promise<ImageBitmap> {
  if (width === bitmap.width && height === bitmap.height) return bitmap;
  const out = await createImageBitmap(bitmap, { resizeWidth: width, resizeHeight: height, resizeQuality: "high", premultiplyAlpha: "none" });
  bitmap.close();
  return out;
}

export function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: true });
  if (!ctx) throw new EngineError("browser-unsupported", "Canvas 2D isn't available in this worker.");
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/** True if any pixel is not fully opaque. */
export function hasTransparency(img: ImageData): boolean {
  const px = new Uint32Array(img.data.buffer, img.data.byteOffset, img.data.byteLength >> 2);
  // Little-endian: alpha is the top byte.
  for (let i = 0; i < px.length; i++) if (px[i]! >>> 24 !== 255) return true;
  return false;
}

/** Composite onto white in place (for formats without alpha). */
export function flattenOnWhite(img: ImageData): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    if (a === 255) continue;
    const k = a / 255;
    d[i] = d[i]! * k + 255 * (1 - k);
    d[i + 1] = d[i + 1]! * k + 255 * (1 - k);
    d[i + 2] = d[i + 2]! * k + 255 * (1 - k);
    d[i + 3] = 255;
  }
}
