/**
 * pdf-to-images with pdf.js. Runs on the MAIN thread (pdf.js needs `document`; its parsing/decoding still
 * happens in its own worker). Pages are rendered one at a time to bound memory; cancellable via ctx.signal.
 */
import { abortError, EngineError } from "../errors";
import { baseName, mimeOf, safeName } from "../formats";
import type { ProcCtx, ProcResult } from "../protocol";

type PdfJs = typeof import("pdfjs-dist");
let lib: Promise<PdfJs> | null = null;

async function loadPdfJs(): Promise<PdfJs> {
  lib ??= (async () => {
    const m = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const worker = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
    m.GlobalWorkerOptions.workerSrc = worker;
    return m as unknown as PdfJs;
  })();
  return lib;
}

const MAX_CANVAS_PIXELS = 100_000_000;

export async function processPdfToImages(ctx: ProcCtx): Promise<ProcResult> {
  const file = ctx.files[0];
  if (!file) throw new EngineError("no-input", "No file selected.");
  if (file.size === 0) throw new EngineError("empty", `${file.name} is empty (0 bytes).`);
  const fmt = String(ctx.options.format ?? "png") === "jpeg" ? "jpeg" : "png";
  const dpi = Math.max(36, Math.min(600, Number(ctx.options.dpi ?? 150)));
  const scale = dpi / 72;
  const signal = ctx.signal;
  const check = () => {
    if (signal?.aborted) throw abortError();
  };

  ctx.progress("loading-engine", 3, "Loading PDF engine");
  const pdfjs = await loadPdfJs();
  check();
  const data = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder("latin1").decode(data.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw new EngineError("corrupt", `${file.name} isn't a valid PDF (missing %PDF header).`);

  const base = `${import.meta.env?.BASE_URL ?? "/"}`;
  const vendor = (ctx.env.vendorBase || `${base}vendor/`).replace(/\/?$/, "/");
  const task = pdfjs.getDocument({
    data,
    standardFontDataUrl: `${vendor}pdfjs/standard_fonts/`,
    cMapUrl: `${vendor}pdfjs/cmaps/`,
    cMapPacked: true,
    wasmUrl: `${vendor}pdfjs/wasm/`,
  });
  const onAbort = () => void task.destroy();
  signal?.addEventListener("abort", onAbort, { once: true });
  const outputs: ProcResult["outputs"] = [];
  try {
    let pdf;
    try {
      pdf = await task.promise;
    } catch (e) {
      check();
      const name = (e as { name?: string }).name;
      if (name === "PasswordException") throw new EngineError("encrypted", `${file.name} is password-protected. Remove the password first.`);
      throw new EngineError("corrupt", `${file.name} couldn't be read — it may be corrupt or truncated (${(e as Error).message.slice(0, 100)}).`);
    }
    const n = pdf.numPages;
    const base0 = baseName(file.name);
    const pad = Math.max(3, String(n).length);
    for (let p = 1; p <= n; p++) {
      check();
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale });
      if (vp.width * vp.height > MAX_CANVAS_PIXELS) {
        page.cleanup();
        throw new EngineError("too-large", `Page ${p} would be ${Math.round(vp.width)}×${Math.round(vp.height)} px at ${dpi} dpi — lower the resolution.`);
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const g = canvas.getContext("2d", { alpha: false })!;
      g.fillStyle = "#fff"; // PDF pages are opaque white paper
      g.fillRect(0, 0, canvas.width, canvas.height);
      const render = page.render({ canvasContext: g, viewport: vp, canvas });
      const cancel = () => render.cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        await render.promise;
      } catch (e) {
        check();
        throw new EngineError("corrupt", `Page ${p} couldn't be rendered (${(e as Error).message.slice(0, 100)}).`);
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
      const blob: Blob = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), `image/${fmt}`, fmt === "jpeg" ? 0.9 : undefined),
      );
      const ext = fmt === "jpeg" ? "jpg" : "png";
      outputs.push({ blob, filename: safeName(`${base0}-page-${String(p).padStart(pad, "0")}.${ext}`), mime: mimeOf(ext), size: blob.size });
      canvas.width = canvas.height = 0;
      page.cleanup();
      ctx.progress("processing", 8 + (90 * p) / n, `Page ${p}/${n}`);
    }
    await task.destroy();
    return { outputs, meta: { pages: n, dpi } };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    void task.destroy().catch?.(() => {});
  }
}
