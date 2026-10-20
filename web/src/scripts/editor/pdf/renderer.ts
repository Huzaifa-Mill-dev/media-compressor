/** pdf.js side of the editor: open a document, read page geometry, render pages/thumbnails to canvases. */
import { loadPdfJs, pdfJsAssetOptions, type PDFDocumentProxy } from "../../../../../engine/src/pdf-libs";
import type { SourcePage } from "./model";

export class PdfOpenError extends Error {
  constructor(
    message: string,
    readonly code: "encrypted" | "corrupt",
  ) {
    super(message);
  }
}

export interface OpenedPdf {
  doc: PDFDocumentProxy;
  sources: SourcePage[];
}

/** Max canvas area we ask the browser for (iOS Safari refuses much beyond ~16 MP). */
const MAX_PIXELS = 16_000_000;

export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  const pdfjs = await loadPdfJs();
  // pdf.js transfers the buffer to its worker; give it a copy so the original stays usable for saving.
  const task = pdfjs.getDocument({ data: bytes.slice(), ...pdfJsAssetOptions(`${import.meta.env.BASE_URL ?? "/"}vendor/`) });
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    if ((e as { name?: string }).name === "PasswordException") throw new PdfOpenError("This PDF is password-protected. Remove the password first, then open it here.", "encrypted");
    throw new PdfOpenError(`This file couldn't be read as a PDF — it may be damaged (${String((e as Error).message ?? e).slice(0, 120)}).`, "corrupt");
  }
  const sources: SourcePage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    sources.push({ width: vp.width, height: vp.height, rotate: page.rotate, transform: vp.transform as SourcePage["transform"] });
  }
  return { doc, sources };
}

/**
 * Render a page into a fresh canvas at `cssScale` (CSS px per point) × devicePixelRatio, with `rotation` absolute
 * degrees (page /Rotate + editor rotation). Resolves to null if `isStale()` turns true before drawing finishes.
 */
export async function renderToCanvas(doc: PDFDocumentProxy, pageIndex: number, rotation: number, cssScale: number, isStale: () => boolean): Promise<HTMLCanvasElement | null> {
  const page = await doc.getPage(pageIndex + 1);
  if (isStale()) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  let scale = cssScale * dpr;
  const vp0 = page.getViewport({ scale: 1, rotation });
  if (vp0.width * vp0.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (vp0.width * vp0.height));
  const vp = page.getViewport({ scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  const g = canvas.getContext("2d", { alpha: false });
  if (!g) return null;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({ canvasContext: g, viewport: vp, canvas });
  try {
    await task.promise;
  } catch (e) {
    if ((e as { name?: string }).name === "RenderingCancelledException") return null;
    throw e;
  }
  return isStale() ? null : canvas;
}
