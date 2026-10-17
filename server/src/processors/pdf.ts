import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { JobError } from "../errors.js";
import { run, safeEnv } from "../proc.js";
import { safeBaseName } from "../util.js";
import { toDecodable } from "./image.js";
import type { ProcCtx, ProcInput, ProcResult } from "./types.js";

async function pageCount(file: string, ctx: ProcCtx, name: string): Promise<number> {
  const r = await run("qpdf", ["--show-npages", file], { signal: ctx.signal, timeoutMs: 30_000, env: safeEnv() });
  const n = Number(r.stdout.trim());
  if (r.code !== 0 || !Number.isInteger(n) || n < 1) {
    const enc = /password|encrypt/i.test(r.stderr);
    throw new JobError(enc ? `${name} is password-protected` : `${name} isn't a readable PDF`);
  }
  if (n > ctx.cfg.maxPdfPages) throw new JobError(`${name} has more than ${ctx.cfg.maxPdfPages} pages`);
  return n;
}

/** qpdf exits 3 for "warnings, output still produced". */
const qpdfOk = (code: number | null) => code === 0 || code === 3;

async function qpdf(ctx: ProcCtx, args: string[], timeoutMs = 120_000): Promise<void> {
  const r = await run("qpdf", args, { signal: ctx.signal, timeoutMs: timeoutMs * ctx.cfg.timeoutScale, memLimitMb: ctx.cfg.childMemLimitMb, env: safeEnv() });
  if (!qpdfOk(r.code)) throw new JobError(`PDF processing failed: ${r.stderr.trim().split("\n")[0]?.slice(0, 160) || "invalid PDF"}`);
}

const GS_BASE = ["-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET", "-dNOPROMPT"];

export async function compressPdf(ctx: ProcCtx): Promise<ProcResult> {
  const input = ctx.inputs[0]!;
  const pages = await pageCount(input.path, ctx, input.name);
  const gsOut = path.join(ctx.workDir, "gs.pdf");
  ctx.progress(10, "Optimising");
  const r = await run("gs", [...GS_BASE, "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.6", `-dPDFSETTINGS=/${ctx.options.level}`, `-sOutputFile=${gsOut}`, input.path], {
    signal: ctx.signal,
    timeoutMs: 480_000 * ctx.cfg.timeoutScale,
    memLimitMb: ctx.cfg.childMemLimitMb,
    env: safeEnv(),
  });
  if (r.code !== 0) throw new JobError("This PDF couldn't be compressed (it may be damaged or protected)");
  ctx.progress(70, "Finalising");
  const packed = path.join(ctx.workDir, "packed.pdf");
  await qpdf(ctx, ["--object-streams=generate", "--compression-level=9", "--recompress-flate", gsOut, packed]);

  // Never return something larger than the upload.
  const candidates = [
    { p: input.path, size: input.size, kept: true },
    ...(await Promise.all([gsOut, packed].map(async (p) => ({ p, size: (await fs.stat(p)).size, kept: false })))),
  ];
  const best = candidates.reduce((a, b) => (b.size < a.size ? b : a));
  const name = `${safeBaseName(input.name, "document")}.pdf`;
  const out = path.join(ctx.outDir, name);
  await fs.copyFile(best.p, out);
  return { outputs: [{ path: out, name }], meta: { pages, keptOriginal: best.kept } };
}

export async function mergePdf(ctx: ProcCtx): Promise<ProcResult> {
  if (ctx.inputs.length < 2) throw new JobError("Add at least two PDFs to merge");
  let total = 0;
  for (const i of ctx.inputs) total += await pageCount(i.path, ctx, i.name);
  if (total > ctx.cfg.maxPdfPages) throw new JobError(`The merged PDF would exceed ${ctx.cfg.maxPdfPages} pages`);
  const out = path.join(ctx.outDir, "merged.pdf");
  await qpdf(ctx, ["--empty", "--pages", ...ctx.inputs.map((i) => i.path), "--", out]);
  return { outputs: [{ path: out, name: "merged.pdf" }], meta: { pages: total } };
}

/** "1-3, 5, 8-end" → [[1,3],[5,5],[8,n]]; throws JobError on anything out of range. */
export function parseRanges(spec: string, n: number): [number, number][] {
  const out: [number, number][] = [];
  for (const tok of spec.split(/[,;]/).map((t) => t.trim()).filter(Boolean)) {
    const m = /^(\d+|end|z)?\s*(?:[-–]\s*(\d+|end|z))?$/i.exec(tok);
    if (!m || (!m[1] && !m[2])) throw new JobError(`"${tok.slice(0, 20)}" isn't a valid page range`);
    const val = (v: string | undefined, d: number) => (v === undefined ? d : /^(end|z)$/i.test(v) ? n : Number(v));
    const a = val(m[1], 1);
    const b = tok.includes("-") || tok.includes("–") ? val(m[2], n) : a;
    if (a < 1 || b > n || a > b) throw new JobError(`Pages ${tok.slice(0, 20)} are outside this ${n}-page document`);
    out.push([a, b]);
  }
  if (!out.length) throw new JobError("Enter at least one page or range");
  return out;
}

export async function splitPdf(ctx: ProcCtx): Promise<ProcResult> {
  const input = ctx.inputs[0]!;
  const n = await pageCount(input.path, ctx, input.name);
  const base = safeBaseName(input.name, "document");
  const ranges: [number, number][] = ctx.options.mode === "every" ? Array.from({ length: n }, (_, i) => [i + 1, i + 1] as [number, number]) : parseRanges(String(ctx.options.ranges), n);
  const outputs = [];
  for (const [i, [a, b]] of ranges.entries()) {
    const name = ctx.options.mode === "every" ? `${base}-page-${a}.pdf` : `${base}-pages-${a}${b > a ? `-${b}` : ""}.pdf`;
    const out = path.join(ctx.outDir, name);
    await qpdf(ctx, [input.path, "--pages", ".", `${a}-${b}`, "--", out]);
    outputs.push({ path: out, name });
    ctx.progress(5 + ((i + 1) / ranges.length) * 90);
  }
  return { outputs, meta: { pages: n } };
}

export async function pdfToImages(ctx: ProcCtx): Promise<ProcResult> {
  const input = ctx.inputs[0]!;
  const n = await pageCount(input.path, ctx, input.name);
  const jpeg = ctx.options.format === "jpeg";
  const ext = jpeg ? "jpg" : "png";
  const base = safeBaseName(input.name, "page");
  const pattern = path.join(ctx.outDir, `page-%04d.${ext}`);
  const r = await run("gs", [...GS_BASE, jpeg ? "-sDEVICE=jpeg" : "-sDEVICE=png16m", "-dJPEGQ=88", `-r${ctx.options.dpi}`, "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4", `-sOutputFile=${pattern}`, input.path], {
    signal: ctx.signal,
    timeoutMs: 480_000 * ctx.cfg.timeoutScale,
    memLimitMb: ctx.cfg.childMemLimitMb,
    env: safeEnv(),
  });
  if (r.code !== 0) throw new JobError("This PDF couldn't be rendered (it may be damaged or protected)");
  const files = (await fs.readdir(ctx.outDir)).filter((f) => f.startsWith("page-")).sort();
  if (!files.length) throw new JobError("No pages were rendered");
  const outputs = [];
  for (const [i, f] of files.entries()) {
    const name = `${base}-page-${i + 1}.${ext}`;
    await fs.rename(path.join(ctx.outDir, f), path.join(ctx.outDir, name));
    outputs.push({ path: path.join(ctx.outDir, name), name });
  }
  return { outputs, meta: { pages: n } };
}

const PAGE = { a4: [595.28, 841.89], letter: [612, 792] } as const;

export async function imagesToPdf(ctx: ProcCtx): Promise<ProcResult> {
  const doc = await PDFDocument.create();
  const margin = Number(ctx.options.margin);
  const size = String(ctx.options.pageSize);
  for (const [i, input] of ctx.inputs.entries()) {
    const src = await toDecodable(input as ProcInput, ctx);
    let buf: Buffer;
    let png = false;
    let w = 0;
    let h = 0;
    try {
      const img = sharp(src, { limitInputPixels: ctx.cfg.maxImagePixels, failOn: "error" }).rotate();
      const meta = await sharp(src, { limitInputPixels: ctx.cfg.maxImagePixels }).metadata();
      png = !!meta.hasAlpha;
      const res = await (png ? img.png() : img.flatten({ background: "#ffffff" }).jpeg({ quality: 90 })).toBuffer({ resolveWithObject: true });
      buf = res.data;
      w = res.info.width;
      h = res.info.height;
    } catch {
      throw new JobError(`${input.name} isn't a readable image`);
    }
    const emb = png ? await doc.embedPng(buf) : await doc.embedJpg(buf);
    if (size === "fit") {
      const page = doc.addPage([w + margin * 2, h + margin * 2]);
      page.drawImage(emb, { x: margin, y: margin, width: w, height: h });
    } else {
      const [pw, ph] = PAGE[size as keyof typeof PAGE];
      const landscape = w > h;
      const [W, H] = landscape ? [ph, pw] : [pw, ph];
      const k = Math.min((W - margin * 2) / w, (H - margin * 2) / h, Infinity);
      const dw = w * k;
      const dh = h * k;
      doc.addPage([W, H]).drawImage(emb, { x: (W - dw) / 2, y: (H - dh) / 2, width: dw, height: dh });
    }
    ctx.progress(5 + ((i + 1) / ctx.inputs.length) * 85);
  }
  const out = path.join(ctx.outDir, "images.pdf");
  await fs.writeFile(out, await doc.save());
  return { outputs: [{ path: out, name: "images.pdf" }], meta: { pages: ctx.inputs.length } };
}
