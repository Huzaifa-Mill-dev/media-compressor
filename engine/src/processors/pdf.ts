/** pdf-merge, pdf-split, images-to-pdf with pdf-lib (lazy). */
import { EngineError } from "../errors";
import { baseName, mimeOf, safeName } from "../formats";
import type { ProcCtx, ProcResult } from "../protocol";
import { parseRanges, rangeIndices } from "../ranges";
import { bitmapToImageData, hasTransparency, inspectImage, loadImage } from "./image-decode";
import { jpegOrientation } from "./imageprobe";

type PdfLib = typeof import("pdf-lib");
let lib: Promise<PdfLib> | null = null;
const loadLib = () => (lib ??= import("pdf-lib"));

async function loadPdf(L: PdfLib, file: File) {
  if (file.size === 0) throw new EngineError("empty", `${file.name} is empty (0 bytes).`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw new EngineError("corrupt", `${file.name} isn't a valid PDF (missing %PDF header).`);
  try {
    return await L.PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (e instanceof L.EncryptedPDFError) {
      throw new EngineError("encrypted", `${file.name} is password-protected. Remove the password first.`);
    }
    throw new EngineError("corrupt", `${file.name} couldn't be read — it may be corrupt or truncated (${(e as Error).message.slice(0, 100)}).`);
  }
}

const pdfBlob = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: "application/pdf" });

async function merge(ctx: ProcCtx, L: PdfLib): Promise<ProcResult> {
  if (ctx.files.length < 2) throw new EngineError("bad-input", "Select at least two PDF files to merge.");
  const out = await L.PDFDocument.create();
  let pages = 0;
  for (let i = 0; i < ctx.files.length; i++) {
    const f = ctx.files[i]!;
    const doc = await loadPdf(L, f);
    const copied = await out.copyPages(doc, doc.getPageIndices());
    copied.forEach((p) => out.addPage(p));
    pages += copied.length;
    ctx.progress("processing", 10 + (80 * (i + 1)) / ctx.files.length, `Merged ${i + 1}/${ctx.files.length}`);
  }
  const bytes = await out.save();
  const blob = pdfBlob(bytes);
  return { outputs: [{ blob, filename: "merged.pdf", mime: "application/pdf", size: blob.size }], meta: { pages } };
}

async function split(ctx: ProcCtx, L: PdfLib): Promise<ProcResult> {
  const file = ctx.files[0]!;
  const src = await loadPdf(L, file);
  const n = src.getPageCount();
  if (n === 0) throw new EngineError("corrupt", `${file.name} has no pages.`);
  const mode = String(ctx.options.mode ?? "every");
  const groups: { indices: number[]; label: string }[] =
    mode === "ranges"
      ? parseRanges(String(ctx.options.ranges ?? ""), n).map((r) => ({
          indices: rangeIndices(r),
          label: r.from === r.to ? `page-${r.from}` : `pages-${r.from}-${r.to}`,
        }))
      : Array.from({ length: n }, (_, i) => ({ indices: [i], label: `page-${String(i + 1).padStart(Math.max(3, String(n).length), "0")}` }));
  const base = baseName(file.name);
  const outputs: ProcResult["outputs"] = [];
  for (let g = 0; g < groups.length; g++) {
    const doc = await L.PDFDocument.create();
    const pages = await doc.copyPages(src, groups[g]!.indices);
    pages.forEach((p) => doc.addPage(p));
    const blob = pdfBlob(await doc.save());
    outputs.push({ blob, filename: safeName(`${base}-${groups[g]!.label}.pdf`), mime: "application/pdf", size: blob.size });
    ctx.progress("processing", 10 + (85 * (g + 1)) / groups.length, `Page ${g + 1}/${groups.length}`);
  }
  return { outputs, meta: { pages: n } };
}

const MM = 72 / 25.4;
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;
const MAX_PAGE = 14400;

/** Normalise any supported image into bytes pdf-lib can embed (JPEG as-is, PNG as-is, else re-encoded). */
async function embeddable(file: File, kind: string): Promise<{ type: "jpg" | "png"; bytes: Uint8Array; width: number; height: number }> {
  const raw = new Uint8Array(await file.arrayBuffer());
  if (kind === "jpg" && jpegOrientation(raw) <= 1) {
    // Fast path: embed the original JPEG untouched (but not CMYK, which pdf-lib handles badly → decode path).
    const { probeDimensions } = await import("./imageprobe");
    const d = probeDimensions(raw, "jpg");
    if (d && !isCmykJpeg(raw)) return { type: "jpg", bytes: raw, width: d.width, height: d.height };
  }
  const img = await loadImage(file);
  try {
    const px = bitmapToImageData(img.bitmap);
    const alpha = hasTransparency(px);
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext("2d")!.drawImage(img.bitmap, 0, 0);
    const blob = await c.convertToBlob(alpha ? { type: "image/png" } : { type: "image/jpeg", quality: 0.92 });
    return { type: alpha ? "png" : "jpg", bytes: new Uint8Array(await blob.arrayBuffer()), width: img.width, height: img.height };
  } finally {
    img.bitmap.close();
  }
}

function isCmykJpeg(b: Uint8Array): boolean {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b[i + 9] === 4;
    i += 2 + ((b[i + 2]! << 8) | b[i + 3]!);
  }
  return false;
}

async function imagesToPdf(ctx: ProcCtx, L: PdfLib): Promise<ProcResult> {
  const pageSize = String(ctx.options.pageSize ?? "fit");
  const margin = Number(ctx.options.margin ?? 0) * MM;
  const doc = await L.PDFDocument.create();
  for (let i = 0; i < ctx.files.length; i++) {
    const f = ctx.files[i]!;
    const { kind } = await inspectImage(f);
    const e = await embeddable(f, kind);
    let image;
    try {
      image = e.type === "jpg" ? await doc.embedJpg(e.bytes) : await doc.embedPng(e.bytes);
    } catch (err) {
      throw new EngineError("corrupt", `${f.name} couldn't be embedded in the PDF (${(err as Error).message.slice(0, 80)}).`);
    }
    // 96 dpi → points
    let iw = e.width * 0.75;
    let ih = e.height * 0.75;
    let pw: number;
    let ph: number;
    if (pageSize === "fit") {
      const k = Math.min(1, (MAX_PAGE - 2 * margin) / Math.max(iw, ih));
      iw *= k;
      ih *= k;
      pw = iw + 2 * margin;
      ph = ih + 2 * margin;
    } else {
      const [a, b] = PAGE_SIZES[pageSize === "letter" ? "letter" : "a4"];
      [pw, ph] = e.width > e.height ? [b, a] : [a, b];
      const k = Math.min((pw - 2 * margin) / iw, (ph - 2 * margin) / ih);
      iw *= k;
      ih *= k;
    }
    const page = doc.addPage([pw, ph]);
    page.drawImage(image, { x: (pw - iw) / 2, y: (ph - ih) / 2, width: iw, height: ih });
    ctx.progress("processing", 10 + (80 * (i + 1)) / ctx.files.length, `Image ${i + 1}/${ctx.files.length}`);
  }
  const blob = pdfBlob(await doc.save());
  const name = ctx.files.length === 1 ? `${baseName(ctx.files[0]!.name)}.pdf` : "images.pdf";
  return { outputs: [{ blob, filename: safeName(name), mime: mimeOf("pdf"), size: blob.size }], meta: { pages: ctx.files.length } };
}

export async function processPdf(ctx: ProcCtx): Promise<ProcResult> {
  if (ctx.files.length === 0) throw new EngineError("no-input", "No file selected.");
  ctx.progress("loading-engine", 3, "Loading PDF engine");
  const L = await loadLib();
  ctx.progress("processing", 8, "Reading");
  switch (ctx.toolId) {
    case "pdf-merge":
      return merge(ctx, L);
    case "pdf-split":
      return split(ctx, L);
    case "images-to-pdf":
      return imagesToPdf(ctx, L);
    default:
      throw new EngineError("bad-tool", `PDF processor can't run ${ctx.toolId}.`);
  }
}

