/**
 * Lazy loaders for pdf.js and pdf-lib, for interactive pages (the PDF editor) that use the libraries directly
 * instead of going through Engine.run. Both resolve from engine/node_modules, so the web app needs no extra deps.
 */
export type PdfJs = typeof import("pdfjs-dist");
export type PdfLib = typeof import("pdf-lib");
export type PDFDocumentProxy = import("pdfjs-dist").PDFDocumentProxy;

let pdfjs: Promise<PdfJs> | null = null;
let pdflib: Promise<PdfLib> | null = null;

/** pdf.js with its worker configured (main thread API; parsing runs in the worker). */
export function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= (async () => {
    const m = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const worker = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
    m.GlobalWorkerOptions.workerSrc = worker;
    return m as unknown as PdfJs;
  })();
  pdfjs.catch(() => (pdfjs = null));
  return pdfjs;
}

export function loadPdfLib(): Promise<PdfLib> {
  pdflib ??= import("pdf-lib");
  pdflib.catch(() => (pdflib = null));
  return pdflib;
}

/** getDocument() options pointing pdf.js at the vendored fonts / cmaps / wasm (web/public/vendor/pdfjs). */
export function pdfJsAssetOptions(vendorBase = "/vendor/"): Record<string, unknown> {
  const v = vendorBase.replace(/\/?$/, "/");
  return {
    standardFontDataUrl: `${v}pdfjs/standard_fonts/`,
    cMapUrl: `${v}pdfjs/cmaps/`,
    cMapPacked: true,
    wasmUrl: `${v}pdfjs/wasm/`,
  };
}
