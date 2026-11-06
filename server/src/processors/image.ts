import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { JobError } from "../errors.js";
import { run, safeEnv } from "../proc.js";
import { safeBaseName } from "../util.js";
import type { ProcCtx, ProcInput, ProcResult } from "./types.js";

sharp.cache(false);
sharp.concurrency(1);

const EFFORT = { fast: 0, balanced: 1, best: 2 } as const;

/** Formats sharp can't decode itself are first converted to PNG with a CLI tool. */
export async function toDecodable(input: ProcInput, ctx: ProcCtx): Promise<string> {
  if (!["heic", "heif", "bmp"].includes(input.ext)) return input.path;
  const out = path.join(ctx.workDir, `${path.basename(input.path)}.decoded.png`);
  if (input.ext === "bmp" && ctx.bins.ffmpeg) {
    const r = await run("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-i", input.path, "-frames:v", "1", out], { signal: ctx.signal, timeoutMs: 60_000, env: safeEnv() });
    if (r.code === 0) return out;
  } else if (ctx.bins.heifDec) {
    const r = await run(ctx.bins.heifDec, [input.path, out], { signal: ctx.signal, timeoutMs: 60_000, env: safeEnv() });
    if (r.code === 0) return out;
  }
  throw new JobError(`${input.name}: .${input.ext} images can't be decoded on this server`);
}

const SVG_MAX_BYTES = 10 * 1024 * 1024;
const SVG_DENSITY = 144;

/** SVGs are rasterised by librsvg: refuse DTD entities and anything that references files/URLs outside the document. */
async function assertSafeSvg(file: string, name: string): Promise<void> {
  const stat = await fs.stat(file);
  if (stat.size > SVG_MAX_BYTES) throw new JobError(`${name} is too large for SVG conversion (max 10 MB)`);
  const text = await fs.readFile(file, "utf8");
  if (/<!ENTITY/i.test(text)) throw new JobError(`${name} uses XML entities, which aren't supported`);
  const externalHref = /href\s*=\s*["']\s*(?!data:|#)[^"'\s]/i;
  const externalUrl = /url\(\s*["']?\s*(?!#|data:)[^)\s"']/i;
  if (externalHref.test(text) || externalUrl.test(text) || /@import/i.test(text)) {
    throw new JobError(`${name} references external files or URLs, which aren't supported — embed them as data URIs`);
  }
}

async function open(file: string, ctx: ProcCtx, name: string, svg = false): Promise<sharp.Sharp> {
  const img = sharp(file, { limitInputPixels: ctx.cfg.maxImagePixels, animated: true, failOn: "error", ...(svg ? { density: SVG_DENSITY } : {}) });
  try {
    const m = await img.metadata();
    if (!m.width || !m.height) throw new Error("no dimensions");
  } catch (e) {
    throw new JobError(`${name} is not a readable image (${friendly(e)})`);
  }
  return img;
}

function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /pixel limit/i.test(m) ? "image dimensions exceed the server limit" : m.slice(0, 120);
}

export async function processImage(ctx: ProcCtx): Promise<ProcResult> {
  const input = ctx.inputs[0]!;
  const o = ctx.options;
  const isCompress = o.format === "original";
  const srcExt = input.ext === "jpeg" ? "jpg" : input.ext;
  let fmt = String(o.format);
  if (fmt === "original") fmt = ["jpg", "png", "webp", "avif"].includes(srcExt) ? srcExt : "webp";
  if (fmt === "jpeg") fmt = "jpg";
  const quality = Number(o.quality);
  const effort = EFFORT[(o.effort as keyof typeof EFFORT) ?? "balanced"];

  ctx.progress(5, "Reading image");
  const isSvg = input.ext === "svg";
  if (isSvg) await assertSafeSvg(input.path, input.name);
  const src = await toDecodable(input, ctx);
  const probe = await open(src, ctx, input.name, isSvg);
  const meta = await probe.metadata();
  const pages = meta.pages ?? 1;

  let pipe = sharp(src, { limitInputPixels: ctx.cfg.maxImagePixels, animated: pages > 1 && fmt === "webp", ...(isSvg ? { density: SVG_DENSITY } : {}) });
  pipe = pipe.rotate(); // honour EXIF orientation, then strip it
  const width = o.width as number | undefined;
  const height = o.height as number | undefined;
  if (width || height) pipe = pipe.resize({ width, height, fit: "inside", withoutEnlargement: true });

  ctx.progress(30, "Encoding");
  const base = pipe.clone();
  switch (fmt) {
    // Same visual-quality scale as the browser engine: AVIF is rescaled (~65 ≈ WebP/JPEG 85) and keeps full-resolution
    // chroma at high quality; WebP uses sharp YUV conversion for crisp coloured edges.
    case "webp": pipe = pipe.webp({ quality, effort: [2, 4, 6][effort], smartSubsample: true }); break;
    case "avif": pipe = pipe.avif({ quality: Math.max(1, Math.round(quality * 0.76)), effort: [2, 4, 7][effort], chromaSubsampling: quality >= 80 ? "4:4:4" : "4:2:0" }); break;
    case "jpg": pipe = pipe.flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: effort === 2 }); break;
    case "png": pipe = pipe.png({ compressionLevel: effort === 0 ? 6 : 9, effort: [3, 6, 9][effort], palette: quality < 100, quality }); break;
    default: throw new JobError(`Unsupported output format ${fmt}`);
  }
  const outName = `${safeBaseName(input.name, "image")}.${fmt}`;
  const outPath = path.join(ctx.outDir, outName);
  let info;
  try {
    info = await pipe.toFile(outPath);
  } catch (e) {
    throw new JobError(`Couldn't process ${input.name}: ${friendly(e)}`);
  }
  // Lossy WebP inflates flat graphics (e.g. Figma PNG exports): when a lossless source didn't shrink much, try lossless.
  if (fmt === "webp" && ["png", "gif", "bmp", "svg"].includes(srcExt) && pages === 1 && info.size > input.size * 0.5) {
    const lossless = await base.webp({ lossless: true, effort: [2, 4, 6][effort] }).toBuffer({ resolveWithObject: true }).catch(() => null);
    if (lossless && lossless.data.length < info.size) {
      await fs.writeFile(outPath, lossless.data);
      info = { ...info, size: lossless.data.length };
    }
  }

  // Never hand back something bigger than what was uploaded (compression only, same format family).
  if (isCompress && info.size >= input.size && fmt === srcExt && !width && !height) {
    await fs.copyFile(input.path, outPath);
    return { outputs: [{ path: outPath, name: outName }], meta: { width: meta.width, height: meta.height, outputWidth: meta.width, outputHeight: meta.height, keptOriginal: true } };
  }
  ctx.progress(95);
  return {
    outputs: [{ path: outPath, name: outName }],
    meta: { width: meta.width, height: meta.pageHeight ?? meta.height, outputWidth: info.width, outputHeight: info.pageHeight ?? info.height, keptOriginal: false },
  };
}
