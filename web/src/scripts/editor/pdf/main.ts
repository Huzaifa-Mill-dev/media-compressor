/**
 * PDF editor controller. Everything happens on this device: pdf.js renders the pages, overlays are DOM elements
 * on top, and pdf-lib writes them into the original file on save (see export.ts).
 *
 * All user-controlled strings reach the DOM through textContent / attributes only.
 */
import { clear, h } from "../../../lib/dom";
import { arrowGeometry, inkPoints, inkSvgPath, normaliseInk } from "./geometry";
import { History } from "./history";
import { MAX_IMAGE_BYTES, readImage } from "./images";
import {
  bounds,
  clone,
  describe,
  FONT_CSS,
  LINE_HEIGHT,
  rotDims,
  uid,
  type Asset,
  type BoxOverlay,
  type DocModel,
  type FontFamily,
  type InkOverlay,
  type LineOverlay,
  type Overlay,
  type PageModel,
  type Rotation,
  type SourcePage,
  type TextOverlay,
} from "./model";
import { openPdf, PdfOpenError, renderToCanvas, type OpenedPdf } from "./renderer";
import { wireSignatureDialog, type Signature } from "./signature";

type Tool = "select" | "text" | "whiteout" | "highlight" | "rect" | "ellipse" | "line" | "arrow" | "ink";
type Pt = { x: number; y: number };

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_PDF_BYTES = 300 * 1024 * 1024;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const PAGE_GAP = 16;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`pdf editor: missing #${id}`);
  return el as T;
};

const TOOL_LABEL: Record<Tool, string> = {
  select: "Select",
  text: "Text",
  whiteout: "White-out",
  highlight: "Highlight",
  rect: "Rectangle",
  ellipse: "Ellipse",
  line: "Line",
  arrow: "Arrow",
  ink: "Draw",
};
const TOOL_HINT: Record<Tool, string> = {
  select: "Click an item to select it. Drag to move, use the handles to resize.",
  text: "Click on the page where the text should start, then type.",
  whiteout: "Drag over content to cover it, then add text on top.",
  highlight: "Drag over the text to highlight.",
  rect: "Drag on the page to draw a rectangle.",
  ellipse: "Drag on the page to draw an ellipse.",
  line: "Drag on the page to draw a line. Hold Shift to snap angles.",
  arrow: "Drag on the page to draw an arrow. Hold Shift to snap angles.",
  ink: "Draw freehand with a mouse, pen or finger.",
};

/** Which style controls apply to which overlay kind. */
const KIND_PROPS: Record<Overlay["kind"], string[]> = {
  text: ["font", "size", "style", "color"],
  rect: ["color", "fill", "fill-on", "width"],
  ellipse: ["color", "fill", "fill-on", "width"],
  whiteout: ["fill"],
  highlight: ["fill"],
  line: ["color", "width"],
  arrow: ["color", "width"],
  ink: ["color", "width"],
  image: [],
};

interface Defaults {
  text: Pick<TextOverlay, "font" | "size" | "color" | "bold" | "italic">;
  rect: Pick<BoxOverlay, "stroke" | "fill" | "strokeWidth">;
  ellipse: Pick<BoxOverlay, "stroke" | "fill" | "strokeWidth">;
  whiteout: Pick<BoxOverlay, "stroke" | "fill" | "strokeWidth">;
  highlight: Pick<BoxOverlay, "stroke" | "fill" | "strokeWidth">;
  line: Pick<LineOverlay, "stroke" | "strokeWidth">;
  arrow: Pick<LineOverlay, "stroke" | "strokeWidth">;
  ink: Pick<InkOverlay, "stroke" | "strokeWidth">;
}

interface PageView {
  id: string;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  layer: HTMLDivElement;
  els: Map<string, HTMLElement>;
  renderedKey: string;
  rendering: string;
  visible: boolean;
  thumb: HTMLLIElement;
  thumbCanvasBox: HTMLElement;
  thumbKey: string;
}

function start(): void {
  const root = document.getElementById("pdfed");
  if (!root) return;

  // ---- elements --------------------------------------------------------------------------------
  const startCard = $("pdfed-start");
  const drop = $<HTMLButtonElement>("pdfed-drop");
  const fileInput = $<HTMLInputElement>("pdfed-file");
  const notices = $("pdfed-notices");
  const app = $("pdfed-app");
  const appNotices = $("pdfed-app-notices");
  const stage = $("pdfed-stage");
  const pagesEl = $("pdfed-pages");
  const thumbsEl = $("pdfed-thumbs");
  const live = $("pdfed-live");
  const imageInput = $<HTMLInputElement>("pdfed-image-input");
  const undoBtn = $<HTMLButtonElement>("pdfed-undo");
  const redoBtn = $<HTMLButtonElement>("pdfed-redo");
  const delBtn = $<HTMLButtonElement>("pdfed-delete");
  const saveBtn = $<HTMLButtonElement>("pdfed-save");
  const zoomVal = $("pdfed-zoom-val");
  const zoomFit = $<HTMLButtonElement>("pdfed-zoom-fit");
  const props = {
    title: $("pdfed-props-title"),
    hint: $("pdfed-hint"),
    font: $<HTMLSelectElement>("pdfed-font"),
    size: $<HTMLInputElement>("pdfed-size"),
    bold: $<HTMLButtonElement>("pdfed-bold"),
    italic: $<HTMLButtonElement>("pdfed-italic"),
    color: $<HTMLInputElement>("pdfed-color"),
    colorLabel: $("pdfed-color-label"),
    fill: $<HTMLInputElement>("pdfed-fill"),
    fillOn: $<HTMLInputElement>("pdfed-fill-on"),
    width: $<HTMLInputElement>("pdfed-width"),
  };
  const toolButtons = [...root.querySelectorAll<HTMLButtonElement>(".pdfed-tool[data-tool]")];

  // ---- state -----------------------------------------------------------------------------------
  let pdf: OpenedPdf | null = null;
  let original: Uint8Array | null = null;
  let fileName = "document.pdf";
  let model: DocModel = { pages: [] };
  let sources: SourcePage[] = [];
  const assets = new Map<string, Asset>();
  const history = new History();
  const views = new Map<string, PageView>();
  let zoom = 1;
  let fit = true;
  let tool: Tool = "select";
  let selected: string | null = null;
  let editing: { id: string; isNew: boolean; before: string } | null = null;
  let currentPage = "";
  let dirty = false;
  let busy = false;
  let generation = 0;
  const defaults: Defaults = {
    text: { font: "helvetica", size: 16, color: "#111111", bold: false, italic: false },
    rect: { stroke: "#e80c08", fill: "", strokeWidth: 2 },
    ellipse: { stroke: "#e80c08", fill: "", strokeWidth: 2 },
    whiteout: { stroke: "", fill: "#ffffff", strokeWidth: 0 },
    highlight: { stroke: "", fill: "#ffe14d", strokeWidth: 0 },
    line: { stroke: "#e80c08", strokeWidth: 2 },
    arrow: { stroke: "#e80c08", strokeWidth: 2 },
    ink: { stroke: "#1a2b6d", strokeWidth: 2 },
  };

  const announce = (text: string) => {
    live.textContent = "";
    requestAnimationFrame(() => (live.textContent = text));
  };
  const showNotice = (where: HTMLElement, kind: "error" | "warn" | "info", text: string) => {
    clear(where);
    const close = h("button", { type: "button", class: "notice-close", "aria-label": "Dismiss message" }, "×");
    const box = h("div", { class: kind === "info" ? "notice" : `notice ${kind}`, role: kind === "error" ? "alert" : "status" }, h("div", null, text), close);
    close.addEventListener("click", () => box.remove());
    where.append(box);
  };

  // ---- lookup helpers --------------------------------------------------------------------------
  const pageById = (id: string) => model.pages.find((p) => p.id === id);
  function findOverlay(id: string | null): { page: PageModel; o: Overlay; index: number } | null {
    if (!id) return null;
    for (const page of model.pages) {
      const index = page.overlays.findIndex((o) => o.id === id);
      if (index >= 0) return { page, o: page.overlays[index]!, index };
    }
    return null;
  }
  const src = (p: PageModel) => sources[p.src]!;
  const pageLabel = (p: PageModel) => `Page ${model.pages.indexOf(p) + 1}`;

  // ---- opening ---------------------------------------------------------------------------------
  async function openFile(file: File): Promise<void> {
    if (busy) return;
    clear(notices);
    if (file.size === 0) return showNotice(notices, "error", `${file.name} is empty (0 bytes).`);
    if (file.size > MAX_PDF_BYTES) return showNotice(notices, "error", `${file.name} is larger than 300 MB, which is more than a browser tab can comfortably edit.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    if (!head.includes("%PDF-")) return showNotice(notices, "error", `${file.name} isn't a PDF.`);
    busy = true;
    drop.setAttribute("aria-busy", "true");
    announce("Opening PDF");
    try {
      const opened = await openPdf(bytes);
      await closeDoc();
      pdf = opened;
      original = bytes;
      sources = opened.sources;
      fileName = file.name;
      model = { pages: sources.map((_, i) => ({ id: uid("p"), src: i, rotate: 0, overlays: [] })) };
      history.clear();
      dirty = false;
      selected = null;
      editing = null;
      fit = true;
      startCard.hidden = true;
      app.hidden = false;
      clear(appNotices);
      $("pdfed-filename").textContent = file.name;
      setTool("select");
      computeFitZoom();
      sync();
      stage.scrollTop = 0;
      // Bring the editor to the top of the viewport, below the sticky site header.
      const headerH = document.querySelector(".header")?.getBoundingClientRect().height ?? 0;
      window.scrollBy({ top: app.getBoundingClientRect().top - headerH - 8, behavior: "instant" });
      currentPage = model.pages[0]?.id ?? "";
      updateCurrent();
      announce(`Opened ${file.name}, ${model.pages.length} page${model.pages.length === 1 ? "" : "s"}`);
    } catch (e) {
      showNotice(notices, "error", e instanceof PdfOpenError ? e.message : `Couldn't open ${file.name}: ${(e as Error).message}`);
    } finally {
      busy = false;
      drop.removeAttribute("aria-busy");
      fileInput.value = "";
    }
  }

  async function closeDoc(): Promise<void> {
    generation++;
    for (const v of views.values()) {
      v.el.remove();
      v.thumb.remove();
    }
    views.clear();
    for (const a of assets.values()) URL.revokeObjectURL(a.url);
    assets.clear();
    const old = pdf;
    pdf = null;
    if (old) await old.doc.loadingTask.destroy().catch(() => {});
  }

  drop.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) void openFile(f);
  });
  for (const t of [drop, startCard]) {
    t.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("drag-over");
    });
    t.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
    t.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("drag-over");
      const f = e.dataTransfer?.files[0];
      if (f) void openFile(f);
    });
  }
  $("pdfed-open").addEventListener("click", () => {
    if (dirty && !confirm("Discard your unsaved edits and open another PDF?")) return;
    fileInput.click();
  });
  window.addEventListener("beforeunload", (e) => {
    if (dirty) e.preventDefault();
  });

  // ---- page views ------------------------------------------------------------------------------
  function makeView(p: PageModel): PageView {
    const canvas = h("canvas", { class: "pdfed-canvas", "aria-hidden": "true" });
    const layer = h("div", { class: "pdfed-layer" });
    const el = h("div", { class: "pdfed-page", "data-id": p.id, role: "group" }, canvas, layer);
    const thumbCanvasBox = h("span", { class: "pdfed-thumb-img" });
    const icon = (d: string[]) => {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", "14");
      svg.setAttribute("height", "14");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      for (const x of d) {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", x);
        svg.append(path);
      }
      return svg;
    };
    const btn = (cls: string, paths: string[]) => h("button", { type: "button", class: `pdfed-thumb-act ${cls}` }, icon(paths));
    const thumb = h(
      "li",
      { class: "pdfed-thumb", draggable: "true", "data-id": p.id },
      h("button", { type: "button", class: "pdfed-thumb-go" }, thumbCanvasBox, h("span", { class: "pdfed-thumb-num" })),
      h(
        "span",
        { class: "pdfed-thumb-acts" },
        btn("rot", ["M21 12a9 9 0 1 1-3-6.7L21 8", "M21 3v5h-5"]),
        btn("up", ["M18 15l-6-6-6 6"]),
        btn("down", ["M6 9l6 6 6-6"]),
        btn("del", ["M3 6h18", "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"]),
      ),
    );
    const v: PageView = { id: p.id, el, canvas, layer, els: new Map(), renderedKey: "", rendering: "", visible: false, thumb, thumbCanvasBox, thumbKey: "" };
    layer.addEventListener("pointerdown", (e) => onPointerDown(e, v));
    layer.addEventListener("dblclick", (e) => {
      const ov = (e.target as Element).closest<HTMLElement>(".pdfed-ov");
      const f = findOverlay(ov?.dataset.id ?? null);
      if (f?.o.kind === "text") startEditing(f.o.id, false);
    });
    layer.addEventListener("keydown", (e) => onOverlayKey(e));
    layer.addEventListener("focusin", (e) => {
      const ov = (e.target as Element).closest<HTMLElement>(".pdfed-ov");
      if (ov?.dataset.id && ov.dataset.id !== selected && !editing) select(ov.dataset.id, false);
    });
    renderIO.observe(el);
    currentIO.observe(el);
    return v;
  }

  /** Reconcile DOM with the model (page order, rotation, overlays), then lay out and render. */
  function sync(): void {
    const keep = new Set(model.pages.map((p) => p.id));
    for (const [id, v] of views) {
      if (keep.has(id)) continue;
      renderIO.unobserve(v.el);
      currentIO.unobserve(v.el);
      v.el.remove();
      v.thumb.remove();
      views.delete(id);
    }
    model.pages.forEach((p, i) => {
      let v = views.get(p.id);
      if (!v) {
        v = makeView(p);
        views.set(p.id, v);
      }
      if (pagesEl.children[i] !== v.el) pagesEl.insertBefore(v.el, pagesEl.children[i] ?? null);
      if (thumbsEl.children[i] !== v.thumb) thumbsEl.insertBefore(v.thumb, thumbsEl.children[i] ?? null);
      const n = i + 1;
      v.el.setAttribute("aria-label", `Page ${n} of ${model.pages.length}`);
      (v.thumb.querySelector(".pdfed-thumb-num") as HTMLElement).textContent = String(n);
      v.thumb.querySelector(".pdfed-thumb-go")!.setAttribute("aria-label", `Go to page ${n}`);
      const acts = v.thumb.querySelectorAll<HTMLButtonElement>(".pdfed-thumb-act");
      const labels = [`Rotate page ${n} clockwise`, `Move page ${n} up`, `Move page ${n} down`, `Delete page ${n}`];
      acts.forEach((b, j) => {
        b.setAttribute("aria-label", labels[j]!);
        b.title = labels[j]!.replace(/ page \d+/, "");
      });
      acts[1]!.disabled = i === 0;
      acts[2]!.disabled = i === model.pages.length - 1;
      acts[3]!.disabled = model.pages.length === 1;
      renderOverlays(v);
    });
    $("pdfed-pagecount").textContent = `${model.pages.length} page${model.pages.length === 1 ? "" : "s"}`;
    if (selected && !findOverlay(selected)) selected = null;
    if (!pageById(currentPage)) currentPage = model.pages[0]?.id ?? "";
    layout();
    renderSelection();
    syncUi();
    queueThumbs();
  }

  function layout(): void {
    zoomVal.textContent = `${Math.round(zoom * 100)}%`;
    zoomFit.setAttribute("aria-label", `Zoom ${Math.round(zoom * 100)}%${fit ? ", fit to width" : ". Fit to width"}`);
    for (const p of model.pages) {
      const v = views.get(p.id);
      if (!v) continue;
      const s = src(p);
      const d = rotDims(s.width, s.height, p.rotate);
      const W = d.w * zoom;
      const H = d.h * zoom;
      v.el.style.width = `${W}px`;
      v.el.style.height = `${H}px`;
      v.el.style.setProperty("--inv", String(1 / zoom));
      v.layer.style.width = `${s.width}px`;
      v.layer.style.height = `${s.height}px`;
      v.layer.style.transform = `translate(${W / 2}px, ${H / 2}px) rotate(${p.rotate}deg) scale(${zoom}) translate(${-s.width / 2}px, ${-s.height / 2}px)`;
      v.layer.dataset.tool = tool;
    }
    scheduleRenders();
  }

  function computeFitZoom(): void {
    if (!fit) return;
    const avail = Math.max(120, stage.clientWidth - 2 * PAGE_GAP);
    const widest = Math.max(1, ...model.pages.map((p) => rotDims(src(p).width, src(p).height, p.rotate).w));
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(avail / widest, 2)));
  }

  function setZoom(z: number, keepFit = false): void {
    const ratio = stage.scrollHeight ? (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight : 0;
    fit = keepFit;
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    if (fit) computeFitZoom();
    layout();
    renderSelection();
    stage.scrollTop = ratio * stage.scrollHeight - stage.clientHeight / 2;
  }
  $("pdfed-zoom-in").addEventListener("click", () => setZoom(zoom * 1.25));
  $("pdfed-zoom-out").addEventListener("click", () => setZoom(zoom / 1.25));
  zoomFit.addEventListener("click", () => setZoom(zoom, true));
  stage.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    { passive: false },
  );
  let lastStageW = 0;
  new ResizeObserver(() => {
    if (app.hidden || stage.clientWidth === lastStageW) return;
    lastStageW = stage.clientWidth;
    if (fit) {
      computeFitZoom();
      layout();
      renderSelection();
    }
  }).observe(stage);

  // ---- rendering (lazy, one page at a time) ----------------------------------------------------
  const renderIO = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const v = views.get((en.target as HTMLElement).dataset.id ?? "");
        if (v) v.visible = en.isIntersecting;
      }
      scheduleRenders();
    },
    { root: stage, rootMargin: "600px 0px" },
  );
  const ratios = new Map<string, number>();
  const currentIO = new IntersectionObserver(
    (entries) => {
      for (const en of entries) ratios.set((en.target as HTMLElement).dataset.id ?? "", en.intersectionRatio);
      let best = "";
      let bestR = 0;
      for (const p of model.pages) {
        const r = ratios.get(p.id) ?? 0;
        if (r > bestR) {
          best = p.id;
          bestR = r;
        }
      }
      if (best && best !== currentPage) {
        currentPage = best;
        updateCurrent();
      }
    },
    { root: stage, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
  );
  function updateCurrent(): void {
    for (const v of views.values()) {
      const on = v.id === currentPage;
      v.thumb.classList.toggle("current", on);
      const go = v.thumb.querySelector(".pdfed-thumb-go");
      if (on) go?.setAttribute("aria-current", "page");
      else go?.removeAttribute("aria-current");
    }
  }

  let renderChain: Promise<void> = Promise.resolve();
  let renderScheduled = false;
  function scheduleRenders(): void {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      const gen = generation;
      for (const p of model.pages) {
        const v = views.get(p.id);
        if (!v || !v.visible) continue;
        const rot = (src(p).rotate + p.rotate) % 360;
        const key = `${p.src}|${rot}|${zoom}|${window.devicePixelRatio}`;
        if (v.renderedKey === key || v.rendering === key) continue;
        v.rendering = key;
        renderChain = renderChain.then(async () => {
          const doc = pdf?.doc;
          if (!doc || gen !== generation || v.rendering !== key || !views.has(v.id)) return;
          try {
            const c = await renderToCanvas(doc, p.src, rot, zoom, () => gen !== generation || v.rendering !== key);
            if (!c) return;
            c.className = "pdfed-canvas";
            c.setAttribute("aria-hidden", "true");
            v.canvas.replaceWith(c);
            v.canvas = c;
            v.renderedKey = key;
            v.el.classList.add("rendered");
          } catch (e) {
            console.warn("pdf editor: render failed", e);
          } finally {
            if (v.rendering === key) v.rendering = "";
          }
        });
      }
    });
  }

  let thumbsQueued = false;
  function queueThumbs(): void {
    if (thumbsQueued) return;
    thumbsQueued = true;
    const gen = generation;
    renderChain = renderChain.then(async () => {
      thumbsQueued = false;
      for (const p of model.pages) {
        const v = views.get(p.id);
        const doc = pdf?.doc;
        if (!v || !doc || gen !== generation) return;
        const rot = (src(p).rotate + p.rotate) % 360;
        const key = `${p.src}|${rot}`;
        if (v.thumbKey === key) continue;
        const d = rotDims(src(p).width, src(p).height, p.rotate);
        const scale = 96 / Math.max(d.w, d.h);
        try {
          const c = await renderToCanvas(doc, p.src, rot, scale, () => gen !== generation);
          if (!c) continue;
          clear(v.thumbCanvasBox);
          v.thumbCanvasBox.append(c);
          v.thumbKey = key;
        } catch (e) {
          console.warn("pdf editor: thumbnail failed", e);
        }
      }
    });
  }

  // ---- overlays: DOM ---------------------------------------------------------------------------
  function renderOverlays(v: PageView): void {
    const p = pageById(v.id);
    if (!p) return;
    const ids = new Set(p.overlays.map((o) => o.id));
    for (const [id, el] of v.els)
      if (!ids.has(id)) {
        el.remove();
        v.els.delete(id);
      }
    p.overlays.forEach((o, i) => {
      let el = v.els.get(o.id);
      if (!el) {
        el = h("div", { class: "pdfed-ov", tabindex: "0", "data-id": o.id });
        v.els.set(o.id, el);
      }
      paint(el, o);
      // Only move nodes that are out of place (re-inserting a focused node would blur it).
      if (v.layer.children[i] !== el) v.layer.insertBefore(el, v.layer.children[i] ?? null);
    });
  }

  function paint(el: HTMLElement, o: Overlay): void {
    el.className = `pdfed-ov pdfed-ov-${o.kind}${o.id === selected ? " selected" : ""}${editing?.id === o.id ? " editing" : ""}`;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `${describe(o)}. Arrow keys move it, Delete removes it${o.kind === "text" ? ", Enter edits it" : ""}.`);
    el.setAttribute("aria-pressed", String(o.id === selected));
    const s = el.style;
    s.cssText = "";
    if (o.kind === "text") {
      s.left = `${o.x}px`;
      s.top = `${o.y}px`;
      s.fontFamily = FONT_CSS[o.font];
      s.fontSize = `${o.size}px`;
      s.lineHeight = String(LINE_HEIGHT);
      s.fontWeight = o.bold ? "700" : "400";
      s.fontStyle = o.italic ? "italic" : "normal";
      s.color = o.color;
      let span = el.firstElementChild as HTMLElement | null;
      if (!span || !span.classList.contains("pdfed-text")) {
        clear(el);
        span = h("span", { class: "pdfed-text" });
        el.append(span);
      }
      if (editing?.id !== o.id && span.textContent !== o.text) span.textContent = o.text;
      return;
    }
    if (o.kind === "image") {
      Object.assign(s, { left: `${o.x}px`, top: `${o.y}px`, width: `${o.w}px`, height: `${o.h}px` });
      const a = assets.get(o.asset);
      let img = el.firstElementChild as HTMLImageElement | null;
      if (!img || img.tagName !== "IMG") {
        clear(el);
        img = h("img", { alt: "", draggable: "false" });
        el.append(img);
      }
      if (a && img.src !== a.url) img.src = a.url;
      return;
    }
    if (o.kind === "rect" || o.kind === "ellipse" || o.kind === "whiteout" || o.kind === "highlight") {
      clear(el);
      Object.assign(s, { left: `${o.x}px`, top: `${o.y}px`, width: `${o.w}px`, height: `${o.h}px`, background: o.fill || "transparent" });
      if (o.stroke && o.strokeWidth) s.border = `${o.strokeWidth}px solid ${o.stroke}`;
      if (o.kind === "ellipse") s.borderRadius = "50%";
      return;
    }
    // Lines, arrows and ink are SVG drawn in absolute layer coordinates (same geometry as the PDF writer).
    const sw = o.strokeWidth;
    const pad = o.kind === "ink" ? 0 : sw * 3 + 6;
    const b = bounds(o);
    const bx = b.x - pad;
    const by = b.y - pad;
    const bw = Math.max(1, b.w + 2 * pad);
    const bh = Math.max(1, b.h + 2 * pad);
    Object.assign(s, { left: `${bx}px`, top: `${by}px`, width: `${bw}px`, height: `${bh}px` });
    clear(el);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `${bx} ${by} ${bw} ${bh}`);
    svg.setAttribute("width", String(bw));
    svg.setAttribute("height", String(bh));
    svg.setAttribute("aria-hidden", "true");
    const path = (d: string, attrs: Record<string, string>) => {
      const pe = document.createElementNS(SVG_NS, "path");
      pe.setAttribute("d", d);
      for (const [k, val] of Object.entries(attrs)) pe.setAttribute(k, val);
      svg.append(pe);
    };
    let d: string;
    if (o.kind === "ink") {
      d = inkSvgPath(inkPoints(o));
    } else {
      const x2 = o.x + o.w;
      const y2 = o.y + o.h;
      if (o.kind === "arrow") {
        const a = arrowGeometry(o.x, o.y, x2, y2, sw);
        d = `M${o.x} ${o.y}L${a.shaftEnd[0]} ${a.shaftEnd[1]}`;
        path(`M${a.head[0][0]} ${a.head[0][1]}L${a.head[1][0]} ${a.head[1][1]}L${a.head[2][0]} ${a.head[2][1]}Z`, { fill: o.stroke, stroke: "none" });
      } else d = `M${o.x} ${o.y}L${x2} ${y2}`;
    }
    path(d, { fill: "none", stroke: o.stroke, "stroke-width": String(sw), "stroke-linecap": "round", "stroke-linejoin": "round" });
    path(d, { class: "pdfed-hit", fill: "none", stroke: "transparent", "stroke-width": String(Math.max(14, sw + 10)), "stroke-linecap": "round" });
    el.append(svg);
  }

  function overlayEl(id: string): HTMLElement | undefined {
    for (const v of views.values()) {
      const el = v.els.get(id);
      if (el) return el;
    }
    return undefined;
  }

  /** Bounds of an overlay as laid out (text is measured from the DOM). */
  function liveBounds(o: Overlay): { x: number; y: number; w: number; h: number } {
    if (o.kind === "text") {
      const el = overlayEl(o.id);
      return bounds(o, el ? { w: Math.max(el.offsetWidth, o.size * 0.5), h: Math.max(el.offsetHeight, o.size * LINE_HEIGHT) } : undefined);
    }
    return bounds(o);
  }

  function renderSelection(): void {
    for (const v of views.values()) v.layer.querySelector(".pdfed-sel")?.remove();
    const f = findOverlay(selected);
    if (!f) return;
    const v = views.get(f.page.id);
    if (!v) return;
    const o = f.o;
    const sel = h("div", { class: `pdfed-sel${editing ? " editing" : ""}`, "aria-hidden": "true" });
    const handles: string[] =
      editing ? [] : o.kind === "line" || o.kind === "arrow" ? ["p1", "p2"] : o.kind === "text" ? ["se"] : ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    if (o.kind === "line" || o.kind === "arrow") {
      sel.classList.add("endpoints");
      Object.assign(sel.style, { left: "0px", top: "0px", width: "0px", height: "0px" });
      for (const hd of handles) {
        const x = hd === "p1" ? o.x : o.x + o.w;
        const y = hd === "p1" ? o.y : o.y + o.h;
        sel.append(h("span", { class: "pdfed-h", "data-h": hd, style: `left:${x}px;top:${y}px` }));
      }
    } else {
      const b = liveBounds(o);
      Object.assign(sel.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
      for (const hd of handles) sel.append(h("span", { class: "pdfed-h", "data-h": hd }));
    }
    v.layer.append(sel);
  }

  // ---- selection, tools, props -----------------------------------------------------------------
  function select(id: string | null, focus = true): void {
    if (editing && editing.id !== id) finishEditing();
    const prev = selected;
    selected = id;
    for (const pid of [prev, id]) {
      const f = findOverlay(pid);
      const el = pid ? overlayEl(pid) : undefined;
      if (f && el) paint(el, f.o);
    }
    renderSelection();
    syncUi();
    if (id && focus) overlayEl(id)?.focus({ preventScroll: true });
  }

  function setTool(t: Tool): void {
    if (editing) finishEditing();
    tool = t;
    for (const b of toolButtons) b.setAttribute("aria-pressed", String(b.dataset.tool === t));
    for (const v of views.values()) v.layer.dataset.tool = t;
    if (t !== "select" && selected) select(null, false);
    syncUi();
  }

  for (const b of toolButtons)
    b.addEventListener("click", (e) => {
      const t = b.dataset.tool as Tool;
      setTool(t);
      // Keyboard activation (no pointer) of a placing tool: put a default item on the current page.
      if (e.detail === 0 && t !== "select" && t !== "ink") {
        insertDefault(t);
      } else if (t !== "select") announce(`${TOOL_LABEL[t]} tool. ${TOOL_HINT[t]}`);
    });

  /** The thing the style controls edit: the selected overlay, or the defaults of the active tool. */
  function styleTarget(): { kind: Overlay["kind"]; o: Overlay | null; d: Record<string, unknown> | null } | null {
    const f = findOverlay(selected);
    if (f) return { kind: f.o.kind, o: f.o, d: (defaults as unknown as Record<string, Record<string, unknown>>)[f.o.kind] ?? null };
    if (tool === "select") return null;
    return { kind: tool, o: null, d: defaults[tool] as unknown as Record<string, unknown> };
  }

  function syncUi(): void {
    const t = styleTarget();
    const show = new Set(t ? KIND_PROPS[t.kind] : []);
    for (const el of root!.querySelectorAll<HTMLElement>("[data-prop]")) el.hidden = !show.has(el.dataset.prop!);
    const f = findOverlay(selected);
    props.title.textContent = f ? describe(f.o) : TOOL_LABEL[tool];
    props.hint.textContent = f ? (f.o.kind === "text" ? "Double-click or press Enter to edit the text." : "") : TOOL_HINT[tool];
    if (t) {
      const v = (t.o ?? t.d) as Record<string, unknown>;
      if (t.kind === "text") {
        props.font.value = String(v.font);
        props.size.value = String(v.size);
        props.bold.setAttribute("aria-pressed", String(!!v.bold));
        props.italic.setAttribute("aria-pressed", String(!!v.italic));
        props.color.value = String(v.color);
        props.colorLabel.textContent = "Colour";
      } else {
        if (typeof v.stroke === "string" && v.stroke) props.color.value = v.stroke;
        props.colorLabel.textContent = t.kind === "rect" || t.kind === "ellipse" ? "Border" : "Colour";
        if (typeof v.fill === "string") {
          props.fillOn.checked = v.fill !== "";
          if (v.fill) props.fill.value = v.fill;
        }
        if (typeof v.strokeWidth === "number") props.width.value = String(v.strokeWidth);
      }
    }
    undoBtn.disabled = !history.canUndo;
    redoBtn.disabled = !history.canRedo;
    delBtn.disabled = !f;
  }

  function applyStyle(key: string, patch: Record<string, unknown>): void {
    const t = styleTarget();
    if (!t) return;
    if (t.d) Object.assign(t.d, patch);
    if (t.o) {
      history.checkpoint(model, `style:${t.o.id}:${key}`);
      Object.assign(t.o, patch);
      markDirty();
      const el = overlayEl(t.o.id);
      if (el) paint(el, t.o);
      renderSelection();
    }
    syncUi();
  }
  props.font.addEventListener("change", () => applyStyle("font", { font: props.font.value as FontFamily }));
  props.size.addEventListener("input", () => {
    const n = Number(props.size.value);
    if (n >= 4 && n <= 400) applyStyle("size", { size: n });
  });
  props.bold.addEventListener("click", () => applyStyle("bold", { bold: props.bold.getAttribute("aria-pressed") !== "true" }));
  props.italic.addEventListener("click", () => applyStyle("italic", { italic: props.italic.getAttribute("aria-pressed") !== "true" }));
  props.color.addEventListener("input", () => {
    const t = styleTarget();
    if (!t) return;
    applyStyle("color", t.kind === "text" ? { color: props.color.value } : { stroke: props.color.value });
  });
  props.fill.addEventListener("input", () => {
    props.fillOn.checked = true;
    applyStyle("fill", { fill: props.fill.value });
  });
  props.fillOn.addEventListener("change", () => applyStyle("fill", { fill: props.fillOn.checked ? props.fill.value : "" }));
  props.width.addEventListener("input", () => {
    const n = Number(props.width.value);
    if (n >= 0 && n <= 40) applyStyle("width", { strokeWidth: n });
  });

  // ---- mutations ------------------------------------------------------------------------------
  function markDirty(): void {
    dirty = true;
    syncUi();
  }

  function addOverlay(page: PageModel, o: Overlay, checkpoint = true): void {
    if (checkpoint) history.checkpoint(model);
    page.overlays.push(o);
    const v = views.get(page.id);
    if (v) renderOverlays(v);
    markDirty();
  }

  function deleteSelected(): void {
    const f = findOverlay(selected);
    if (!f) return;
    if (editing) {
      editing = null;
    }
    history.checkpoint(model);
    f.page.overlays.splice(f.index, 1);
    selected = null;
    const v = views.get(f.page.id);
    if (v) renderOverlays(v);
    renderSelection();
    markDirty();
    announce(`${describe(f.o)} deleted`);
    v?.el.querySelector<HTMLElement>(".pdfed-ov")?.focus({ preventScroll: true }) ?? stage.focus({ preventScroll: true });
  }
  delBtn.addEventListener("click", deleteSelected);

  function restore(next: DocModel | null, verb: string): void {
    if (!next) return;
    if (editing) {
      editing = null;
    }
    model = next;
    sync();
    markDirty();
    announce(verb);
  }
  const undo = () => restore(history.undo(model), "Undone");
  const redo = () => restore(history.redo(model), "Redone");
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);

  /** Centre of the visible part of the current page, in its base-view space. */
  function placementPoint(): { page: PageModel; pt: Pt } | null {
    const page = pageById(currentPage) ?? model.pages[0];
    if (!page) return null;
    const v = views.get(page.id)!;
    const sr = stage.getBoundingClientRect();
    const pr = v.el.getBoundingClientRect();
    const cx = (Math.max(sr.left, pr.left) + Math.min(sr.right, pr.right)) / 2;
    const cy = (Math.max(sr.top, pr.top) + Math.min(sr.bottom, pr.bottom)) / 2;
    const s = src(page);
    const pt = toLayer(v, page, cx, cy);
    return { page, pt: { x: Math.min(Math.max(pt.x, 20), s.width - 20), y: Math.min(Math.max(pt.y, 20), s.height - 20) } };
  }

  function insertDefault(t: Exclude<Tool, "select" | "ink">): void {
    const at = placementPoint();
    if (!at) return;
    const { page, pt } = at;
    let o: Overlay;
    if (t === "text") {
      o = { id: uid("o"), kind: "text", x: pt.x - 40, y: pt.y - 10, text: "", ...defaults.text };
      addOverlay(page, o);
      setTool("select");
      select(o.id);
      startEditing(o.id, true);
      return;
    }
    if (t === "line" || t === "arrow") o = { id: uid("o"), kind: t, x: pt.x - 60, y: pt.y, w: 120, h: 0, ...defaults[t] };
    else {
      const w = t === "highlight" ? 160 : 140;
      const hh = t === "highlight" ? 18 : 70;
      o = { id: uid("o"), kind: t, x: pt.x - w / 2, y: pt.y - hh / 2, w, h: hh, ...defaults[t] };
    }
    addOverlay(page, o);
    setTool("select");
    select(o.id);
    announce(`${describe(o)} added to ${pageLabel(page)}. Use the arrow keys to move it.`);
  }

  // ---- text editing ----------------------------------------------------------------------------
  function startEditing(id: string, isNew: boolean): void {
    const f = findOverlay(id);
    if (!f || f.o.kind !== "text") return;
    if (editing && editing.id !== id) finishEditing();
    if (selected !== id) select(id, false);
    const el = overlayEl(id);
    const span = el?.querySelector<HTMLElement>(".pdfed-text");
    if (!el || !span) return;
    if (!isNew) history.checkpoint(model, `edit:${id}`);
    editing = { id, isNew, before: f.o.text };
    span.contentEditable = "plaintext-only";
    if (span.contentEditable !== "plaintext-only") span.contentEditable = "true";
    span.setAttribute("role", "textbox");
    span.setAttribute("aria-multiline", "true");
    span.setAttribute("aria-label", "Text");
    el.classList.add("editing");
    el.removeAttribute("tabindex");
    span.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(span);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    renderSelection();
    syncUi();
  }

  const readText = (span: HTMLElement) => span.innerText.replace(/\r/g, "").replace(/ /g, " ").replace(/\n+$/, "");

  function finishEditing(): void {
    const ed = editing;
    if (!ed) return;
    editing = null;
    const f = findOverlay(ed.id);
    const el = overlayEl(ed.id);
    const span = el?.querySelector<HTMLElement>(".pdfed-text");
    if (span) {
      span.removeAttribute("contenteditable");
      span.removeAttribute("role");
      span.removeAttribute("aria-multiline");
      span.removeAttribute("aria-label");
    }
    el?.classList.remove("editing");
    el?.setAttribute("tabindex", "0");
    if (!f || f.o.kind !== "text") return;
    const text = span ? readText(span) : f.o.text;
    if (!text.trim()) {
      // Empty text box: remove it. A brand-new one leaves no history step behind.
      f.page.overlays.splice(f.index, 1);
      if (ed.isNew) history.dropLast();
      else markDirty();
      if (selected === ed.id) selected = null;
    } else {
      f.o.text = text;
      if (text === ed.before && !ed.isNew) history.dropLast();
      else markDirty();
    }
    const v = views.get(f.page.id);
    if (v) renderOverlays(v);
    renderSelection();
    syncUi();
  }

  root.addEventListener("input", (e) => {
    if (!editing) return;
    const span = (e.target as Element).closest?.(".pdfed-text") as HTMLElement | null;
    const f = findOverlay(editing.id);
    if (!span || !f || f.o.kind !== "text") return;
    f.o.text = readText(span);
    renderSelection();
  });
  root.addEventListener(
    "keydown",
    (e) => {
      if (!editing || !(e.target as Element).closest?.(".pdfed-text")) return;
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        const id = editing.id;
        finishEditing();
        overlayEl(id)?.focus({ preventScroll: true });
      }
    },
    true,
  );
  root.addEventListener("focusout", (e) => {
    if (!editing || !(e.target as Element).closest?.(".pdfed-text")) return;
    // Defer: the pointerdown that moved focus may already be handling this.
    setTimeout(() => {
      if (editing && !document.activeElement?.closest?.(".pdfed-text")) finishEditing();
    }, 0);
  });

  // ---- pointer interaction ---------------------------------------------------------------------
  function toLayer(v: PageView, page: PageModel, clientX: number, clientY: number): Pt {
    const r = v.el.getBoundingClientRect();
    const s = src(page);
    const px = clientX - r.left - r.width / 2;
    const py = clientY - r.top - r.height / 2;
    const a = (-page.rotate * Math.PI) / 180;
    const x = px * Math.cos(a) - py * Math.sin(a);
    const y = px * Math.sin(a) + py * Math.cos(a);
    return { x: x / zoom + s.width / 2, y: y / zoom + s.height / 2 };
  }

  const snap45 = (dx: number, dy: number): [number, number] => {
    const len = Math.hypot(dx, dy);
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return [Math.cos(ang) * len, Math.sin(ang) * len];
  };

  function onPointerDown(e: PointerEvent, v: PageView): void {
    if (e.button !== 0 || busy) return;
    const target = e.target as Element;
    if (editing && target.closest(".pdfed-text[contenteditable]")) return;
    if (editing) finishEditing();
    const page = pageById(v.id);
    if (!page) return;
    currentPage = page.id;
    updateCurrent();
    const p0 = toLayer(v, page, e.clientX, e.clientY);
    const handle = target.closest<HTMLElement>(".pdfed-h");
    const ovEl = target.closest<HTMLElement>(".pdfed-ov");
    let move: ((p: Pt, ev: PointerEvent) => void) | null = null;
    let up: ((p: Pt) => void) | null = null;

    if (handle && selected) {
      const f = findOverlay(selected);
      if (!f) return;
      const o = f.o;
      const hd = handle.dataset.h!;
      const b0 = liveBounds(o);
      const start = clone(o);
      let started = false;
      move = (p, ev) => {
        if (!started) {
          history.checkpoint(model);
          started = true;
        }
        if (o.kind === "line" || o.kind === "arrow") {
          const s = start as LineOverlay;
          const fixed = hd === "p1" ? { x: s.x + s.w, y: s.y + s.h } : { x: s.x, y: s.y };
          let [dx, dy] = [p.x - fixed.x, p.y - fixed.y];
          if (ev.shiftKey) [dx, dy] = snap45(dx, dy);
          if (hd === "p1") Object.assign(o, { x: fixed.x + dx, y: fixed.y + dy, w: -dx, h: -dy });
          else Object.assign(o, { w: dx, h: dy });
        } else if (o.kind === "text") {
          const s = start as TextOverlay;
          const ratio = Math.max(0.05, (p.y - b0.y) / b0.h);
          o.size = Math.round(Math.min(400, Math.max(4, s.size * ratio)) * 2) / 2;
        } else {
          const MIN = 4;
          let x1 = b0.x;
          let y1 = b0.y;
          let x2 = b0.x + b0.w;
          let y2 = b0.y + b0.h;
          if (hd.includes("w")) x1 = Math.min(p.x, x2 - MIN);
          if (hd.includes("e")) x2 = Math.max(p.x, x1 + MIN);
          if (hd.includes("n")) y1 = Math.min(p.y, y2 - MIN);
          if (hd.includes("s")) y2 = Math.max(p.y, y1 + MIN);
          const keep = hd.length === 2 && ((o.kind === "image" || o.kind === "ink") !== ev.shiftKey);
          if (keep) {
            const ratio = b0.w / b0.h;
            let w = x2 - x1;
            let hh = y2 - y1;
            if (w / hh > ratio) w = hh * ratio;
            else hh = w / ratio;
            if (hd.includes("w")) x1 = x2 - w;
            else x2 = x1 + w;
            if (hd.includes("n")) y1 = y2 - hh;
            else y2 = y1 + hh;
          }
          Object.assign(o, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
        }
        const el = overlayEl(o.id);
        if (el) paint(el, o);
        renderSelection();
      };
      up = () => {
        if (started) markDirty();
      };
    } else if (tool === "select") {
      if (!ovEl?.dataset.id) {
        select(null, false);
        return; // let the stage scroll / pan normally
      }
      const id = ovEl.dataset.id;
      select(id);
      const f = findOverlay(id)!;
      const o = f.o;
      const x0 = o.x;
      const y0 = o.y;
      let started = false;
      move = (p) => {
        const dx = p.x - p0.x;
        const dy = p.y - p0.y;
        if (!started) {
          if (Math.hypot(dx, dy) * zoom < 3) return;
          history.checkpoint(model);
          started = true;
        }
        o.x = x0 + dx;
        o.y = y0 + dy;
        paint(ovEl, o);
        renderSelection();
      };
      up = () => {
        if (started) markDirty();
      };
    } else if (tool === "text") {
      e.preventDefault();
      const o: TextOverlay = { id: uid("o"), kind: "text", x: p0.x, y: p0.y - defaults.text.size * LINE_HEIGHT * 0.5, text: "", ...defaults.text };
      addOverlay(page, o);
      setTool("select");
      select(o.id, false);
      // preventDefault() above suppresses the mousedown focus change, so focusing now sticks.
      startEditing(o.id, true);
      return;
    } else if (tool === "ink") {
      e.preventDefault();
      const pts: [number, number][] = [[p0.x, p0.y]];
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "pdfed-ink-live");
      const s = src(page);
      svg.setAttribute("viewBox", `0 0 ${s.width} ${s.height}`);
      const path = document.createElementNS(SVG_NS, "path");
      Object.entries({ fill: "none", stroke: defaults.ink.stroke, "stroke-width": String(defaults.ink.strokeWidth), "stroke-linecap": "round", "stroke-linejoin": "round" }).forEach(([k, val]) => path.setAttribute(k, val));
      svg.append(path);
      v.layer.append(svg);
      move = (p, ev) => {
        for (const ce of ev.getCoalescedEvents?.() ?? [ev]) {
          const q = toLayer(v, page, ce.clientX, ce.clientY);
          pts.push([q.x, q.y]);
        }
        path.setAttribute("d", inkSvgPath([pts]));
        void p;
      };
      up = () => {
        svg.remove();
        const sw = defaults.ink.strokeWidth;
        const n = normaliseInk([simplify(pts, 0.35)], sw / 2 + 1);
        addOverlay(page, { id: uid("o"), kind: "ink", ...n, stroke: defaults.ink.stroke, strokeWidth: sw });
      };
    } else {
      // Box / line tools: drag out the shape; a plain click drops a default-sized one.
      e.preventDefault();
      const kind = tool;
      history.checkpoint(model);
      const o: Overlay =
        kind === "line" || kind === "arrow"
          ? { id: uid("o"), kind, x: p0.x, y: p0.y, w: 0, h: 0, ...defaults[kind] }
          : { id: uid("o"), kind, x: p0.x, y: p0.y, w: 0, h: 0, ...defaults[kind] };
      addOverlay(page, o, false);
      selected = o.id;
      let dragged = false;
      move = (p, ev) => {
        let dx = p.x - p0.x;
        let dy = p.y - p0.y;
        if (Math.hypot(dx, dy) * zoom > 3) dragged = true;
        if (o.kind === "line" || o.kind === "arrow") {
          if (ev.shiftKey) [dx, dy] = snap45(dx, dy);
          Object.assign(o, { w: dx, h: dy });
        } else Object.assign(o, { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(dx), h: Math.abs(dy) });
        const el = overlayEl(o.id);
        if (el) paint(el, o);
        renderSelection();
      };
      up = () => {
        if (!dragged) {
          if (o.kind === "line" || o.kind === "arrow") Object.assign(o, { w: 120, h: 0 });
          else {
            const w = o.kind === "highlight" ? 160 : 140;
            const hh = o.kind === "highlight" ? 18 : 70;
            Object.assign(o, { x: p0.x - w / 2, y: p0.y - hh / 2, w, h: hh });
          }
        }
        selected = null;
        setTool("select");
        select(o.id);
        announce(`${describe(o)} added`);
      };
    }

    if (!move) return;
    v.layer.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => move!(toLayer(v, page, ev.clientX, ev.clientY), ev);
    const onUp = (ev: PointerEvent) => {
      v.layer.removeEventListener("pointermove", onMove);
      v.layer.removeEventListener("pointerup", onUp);
      v.layer.removeEventListener("pointercancel", onUp);
      if (v.layer.hasPointerCapture(ev.pointerId)) v.layer.releasePointerCapture(ev.pointerId);
      up?.(toLayer(v, page, ev.clientX, ev.clientY));
    };
    v.layer.addEventListener("pointermove", onMove);
    v.layer.addEventListener("pointerup", onUp);
    v.layer.addEventListener("pointercancel", onUp);
  }

  /** Drop points closer than `tol` to the previous kept point (pointer events are very dense). */
  function simplify(pts: [number, number][], tol: number): [number, number][] {
    const out: [number, number][] = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= tol) out.push(p);
    }
    const end = pts[pts.length - 1];
    if (end && out[out.length - 1] !== end && out.length > 1) out.push(end);
    return out;
  }

  // ---- keyboard --------------------------------------------------------------------------------
  function onOverlayKey(e: KeyboardEvent): void {
    if (editing) return;
    const el = (e.target as Element).closest<HTMLElement>(".pdfed-ov");
    const f = findOverlay(el?.dataset.id ?? null);
    if (!f) return;
    const step = e.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const mv = moves[e.key];
    if (mv) {
      e.preventDefault();
      // Arrow keys move in screen directions, so undo the page rotation.
      const page = f.page;
      const a = (-page.rotate * Math.PI) / 180;
      const dx = mv[0] * Math.cos(a) - mv[1] * Math.sin(a);
      const dy = mv[0] * Math.sin(a) + mv[1] * Math.cos(a);
      history.checkpoint(model, `nudge:${f.o.id}`);
      f.o.x += Math.round(dx * 100) / 100;
      f.o.y += Math.round(dy * 100) / 100;
      paint(el!, f.o);
      renderSelection();
      markDirty();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === "Enter" && f.o.kind === "text") {
      e.preventDefault();
      startEditing(f.o.id, false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      select(null, false);
      stage.focus({ preventScroll: true });
    }
  }

  document.addEventListener("keydown", (e) => {
    if (app.hidden || editing) return;
    const t = e.target as HTMLElement;
    if (t.closest("dialog")) return;
    const inField = t.matches("input, select, textarea, [contenteditable]");
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "z" && !inField) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && k === "y" && !inField) {
      e.preventDefault();
      redo();
    } else if (e.key === "Escape" && !inField && (tool !== "select" || selected)) {
      if (tool !== "select") setTool("select");
      else select(null, false);
    }
  });

  /** Roving tabindex + arrow keys within each toolbar (WAI-ARIA toolbar pattern). */
  for (const bar of root.querySelectorAll<HTMLElement>("[role=toolbar]")) {
    const items = () => [...bar.querySelectorAll<HTMLElement>("button")].filter((b) => !(b as HTMLButtonElement).disabled && !b.closest("[hidden]"));
    const initial = items();
    initial.forEach((b, i) => (b.tabIndex = i === 0 ? 0 : -1));
    bar.addEventListener("keydown", (e) => {
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      let n = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") n = (i + 1) % list.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = (i - 1 + list.length) % list.length;
      else if (e.key === "Home") n = 0;
      else if (e.key === "End") n = list.length - 1;
      if (n < 0) return;
      e.preventDefault();
      list.forEach((b) => (b.tabIndex = -1));
      list[n]!.tabIndex = 0;
      list[n]!.focus();
    });
    bar.addEventListener("focusin", (e) => {
      const list = items();
      if (!list.includes(e.target as HTMLElement)) return;
      list.forEach((b) => (b.tabIndex = b === e.target ? 0 : -1));
    });
    // If the roving item becomes disabled, keep the toolbar reachable.
    new MutationObserver(() => {
      const list = items();
      if (list.length && !list.some((b) => b.tabIndex === 0)) list[0]!.tabIndex = 0;
    }).observe(bar, { attributes: true, subtree: true, attributeFilter: ["disabled"] });
  }

  // ---- pages: thumbnails -----------------------------------------------------------------------
  function pageAction(id: string, act: string): void {
    const i = model.pages.findIndex((p) => p.id === id);
    const p = model.pages[i];
    if (!p) return;
    if (act === "go") {
      views.get(id)?.el.scrollIntoView({ block: "start", behavior: "smooth" });
      currentPage = id;
      updateCurrent();
      return;
    }
    if (act === "del" && model.pages.length === 1) return announce("A PDF needs at least one page.");
    history.checkpoint(model);
    if (act === "rot") {
      p.rotate = ((p.rotate + 90) % 360) as Rotation;
      if (fit) computeFitZoom();
      announce(`Page ${i + 1} rotated to ${p.rotate} degrees`);
    } else if (act === "up" && i > 0) {
      model.pages.splice(i, 1);
      model.pages.splice(i - 1, 0, p);
      announce(`Page moved to position ${i}`);
    } else if (act === "down" && i < model.pages.length - 1) {
      model.pages.splice(i, 1);
      model.pages.splice(i + 1, 0, p);
      announce(`Page moved to position ${i + 2}`);
    } else if (act === "del") {
      model.pages.splice(i, 1);
      announce(`Page ${i + 1} deleted`);
    } else {
      history.dropLast();
      return;
    }
    markDirty();
    sync();
    // Keep keyboard focus on the same control of the same (moved) page where possible.
    const v = views.get(id);
    const cls = act === "del" ? null : act;
    const next = cls && v ? v.thumb.querySelector<HTMLButtonElement>(`.pdfed-thumb-act.${cls}`) : null;
    if (next && !next.disabled) next.focus();
    else (v ?? views.get(model.pages[Math.min(i, model.pages.length - 1)]!.id))?.thumb.querySelector<HTMLElement>(".pdfed-thumb-go")?.focus();
  }
  thumbsEl.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button");
    const li = b?.closest<HTMLElement>(".pdfed-thumb");
    if (!b || !li?.dataset.id) return;
    const act = b.classList.contains("pdfed-thumb-go") ? "go" : (["rot", "up", "down", "del"].find((c) => b.classList.contains(c)) ?? "");
    pageAction(li.dataset.id, act);
  });
  let dragId = "";
  thumbsEl.addEventListener("dragstart", (e) => {
    const li = (e.target as Element).closest<HTMLElement>(".pdfed-thumb");
    if (!li?.dataset.id || !e.dataTransfer) return;
    dragId = li.dataset.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `page:${dragId}`);
    li.classList.add("dragging");
  });
  const clearDropMarks = () => thumbsEl.querySelectorAll(".drop-before, .drop-after, .dragging").forEach((n) => n.classList.remove("drop-before", "drop-after", "dragging"));
  thumbsEl.addEventListener("dragend", () => {
    dragId = "";
    clearDropMarks();
  });
  const dropSide = (li: HTMLElement, e: DragEvent): "before" | "after" => {
    const r = li.getBoundingClientRect();
    const horizontal = getComputedStyle(thumbsEl).flexDirection === "row";
    return horizontal ? (e.clientX < r.left + r.width / 2 ? "before" : "after") : e.clientY < r.top + r.height / 2 ? "before" : "after";
  };
  thumbsEl.addEventListener("dragover", (e) => {
    if (!dragId) return;
    const li = (e.target as Element).closest<HTMLElement>(".pdfed-thumb");
    if (!li) return;
    e.preventDefault();
    thumbsEl.querySelectorAll(".drop-before, .drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
    li.classList.add(`drop-${dropSide(li, e)}`);
  });
  thumbsEl.addEventListener("drop", (e) => {
    const li = (e.target as Element).closest<HTMLElement>(".pdfed-thumb");
    const id = dragId;
    clearDropMarks();
    dragId = "";
    if (!li?.dataset.id || !id || li.dataset.id === id) return;
    e.preventDefault();
    const from = model.pages.findIndex((p) => p.id === id);
    if (from < 0) return;
    history.checkpoint(model);
    const [p] = model.pages.splice(from, 1);
    let to = model.pages.findIndex((q) => q.id === li.dataset.id);
    if (dropSide(li, e) === "after") to++;
    model.pages.splice(to, 0, p!);
    markDirty();
    sync();
    announce(`Page moved to position ${to + 1}`);
  });

  // ---- images & signatures ---------------------------------------------------------------------
  async function insertImage(file: File, at?: { page: PageModel; pt: Pt }): Promise<void> {
    if (file.size > MAX_IMAGE_BYTES) return showNotice(appNotices, "error", `${file.name} is larger than 40 MB.`);
    let asset: Asset;
    try {
      asset = await readImage(file);
    } catch (e) {
      return showNotice(appNotices, "error", (e as Error).message);
    }
    const place = at ?? placementPoint();
    if (!place) return;
    const id = uid("a");
    assets.set(id, asset);
    const s = src(place.page);
    // 1 image px = 0.75 pt (96 dpi), capped at half the page.
    let w = asset.width * 0.75;
    let hh = asset.height * 0.75;
    const k = Math.min(1, (s.width * 0.5) / w, (s.height * 0.5) / hh);
    w *= k;
    hh *= k;
    const o: Overlay = { id: uid("o"), kind: "image", x: place.pt.x - w / 2, y: place.pt.y - hh / 2, w, h: hh, asset: id };
    addOverlay(place.page, o);
    setTool("select");
    select(o.id);
    announce(`Image added to ${pageLabel(place.page)}`);
  }
  $("pdfed-add-image").addEventListener("click", () => imageInput.click());
  imageInput.addEventListener("change", () => {
    const f = imageInput.files?.[0];
    imageInput.value = "";
    if (f) void insertImage(f);
  });

  const sign = wireSignatureDialog((sig: Signature) => {
    const at = placementPoint();
    if (!at) return;
    let o: Overlay;
    if (sig.kind === "text") {
      o = { id: uid("o"), kind: "text", x: at.pt.x - 80, y: at.pt.y - 18, text: sig.text, font: "times", size: 28, color: sig.color, bold: false, italic: true };
    } else {
      const n = normaliseInk(sig.strokes, 2);
      const target = Math.min(180, src(at.page).width * 0.4);
      const k = target / n.w;
      const w = n.w * k;
      const hh = n.h * k;
      o = { id: uid("o"), kind: "ink", x: at.pt.x - w / 2, y: at.pt.y - hh / 2, w, h: hh, strokes: n.strokes, stroke: sig.color, strokeWidth: Math.max(0.75, Math.round(2.5 * k * 4) / 4) };
    }
    addOverlay(at.page, o);
    setTool("select");
    select(o.id);
    announce(`Signature added to ${pageLabel(at.page)}`);
  });
  $("pdfed-add-sign").addEventListener("click", () => sign.open());

  // Drop images onto a page (or a new PDF onto the editor).
  stage.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
  stage.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files[0];
    if (!f) return;
    e.preventDefault();
    if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
      if (!dirty || confirm("Discard your unsaved edits and open this PDF?")) void openFile(f);
      return;
    }
    const pageEl = (e.target as Element).closest<HTMLElement>(".pdfed-page");
    const page = pageById(pageEl?.dataset.id ?? "");
    const v = page ? views.get(page.id) : undefined;
    void insertImage(f, page && v ? { page, pt: toLayer(v, page, e.clientX, e.clientY) } : undefined);
  });

  // ---- save ------------------------------------------------------------------------------------
  saveBtn.addEventListener("click", async () => {
    if (!original || busy) return;
    if (editing) finishEditing();
    busy = true;
    saveBtn.disabled = true;
    saveBtn.setAttribute("aria-busy", "true");
    const label = saveBtn.querySelector("span")!;
    label.textContent = "Saving…";
    announce("Saving PDF");
    try {
      const { exportPdf } = await import("./export");
      const { bytes, replacedChars } = await exportPdf(original, model, sources, assets);
      const name = `${fileName.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "_") || "document"}-edited.pdf`;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      const a = h("a", { href: url, download: name, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      dirty = false;
      if (replacedChars) showNotice(appNotices, "warn", `${replacedChars} character${replacedChars === 1 ? "" : "s"} couldn't be written with the standard PDF fonts and became “?”.`);
      else clear(appNotices);
      announce(`Saved ${name}`);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      showNotice(
        appNotices,
        "error",
        /encrypt/i.test(msg) ? "This PDF is encrypted, so it can't be edited. Remove its protection first." : `Couldn't save the PDF: ${msg.slice(0, 200)}`,
      );
    } finally {
      busy = false;
      saveBtn.disabled = false;
      saveBtn.removeAttribute("aria-busy");
      label.textContent = "Download PDF";
    }
  });

  syncUi();
  root.dataset.ready = "1";
}

start();
