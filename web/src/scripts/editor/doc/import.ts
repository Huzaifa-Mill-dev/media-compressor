/**
 * File → editor HTML. DOCX is converted in the browser with mammoth; TXT/HTML are read directly.
 * ODT/RTF/DOC and PDF need the server (LibreOffice / pdf2docx) and are first converted to DOCX there.
 */
import { MAX_INDENT } from "./extensions";
import { HIGHLIGHTS } from "./highlights";
import { runServerTool, serverHas, type ProgressFn } from "./server";

export const OPEN_ACCEPT = ".docx,.odt,.rtf,.doc,.txt,.text,.html,.htm,.pdf";

export class ImportError extends Error {}

/** mammoth ignores alignment, indent, font size and highlight; they travel through the HTML as private-use markers. */
const P_OPEN = "\uE000";
const P_CLOSE = "\uE001";
const R_OPEN = "\uE002";
const R_MID = "\uE003";
const R_CLOSE = "\uE004";

const STYLE_MAP = [
  "u => u",
  "strike => s",
  "br[type='page'] => hr.page-break",
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='Code'] => pre:separator('\\n')",
];


type MElement = { type: string; children?: MElement[]; [k: string]: unknown };
const text = (value: string): MElement => ({ type: "text", value });

function markDocument(el: MElement): MElement {
  if (el.children) el.children = el.children.map(markDocument);
  if (el.type === "paragraph") {
    const parts: string[] = [];
    const align = String(el.alignment ?? "");
    const a = align === "both" || align === "distribute" ? "justify" : align === "end" ? "right" : align;
    if (a === "center" || a === "right" || a === "justify") parts.push(`a=${a}`);
    const start = Number((el.indent as { start?: string | null } | undefined)?.start ?? 0);
    if (!el.numbering && start > 0) {
      const lvl = Math.min(MAX_INDENT, Math.round(start / 720));
      if (lvl > 0) parts.push(`i=${lvl}`);
    }
    if (parts.length) el.children = [{ type: "run", children: [text(`${P_OPEN}${parts.join(";")}${P_CLOSE}`)] }, ...(el.children ?? [])];
  } else if (el.type === "run") {
    const parts: string[] = [];
    if (typeof el.fontSize === "number" && el.fontSize > 0) parts.push(`s=${el.fontSize}`);
    if (typeof el.highlight === "string" && HIGHLIGHTS[el.highlight]) parts.push(`h=${el.highlight}`);
    if (parts.length && el.children?.length) el.children = [text(`${R_OPEN}${parts.join(";")}${R_MID}`), ...el.children, text(R_CLOSE)];
  }
  return el;
}

const kv = (s: string) => Object.fromEntries(s.split(";").map((p) => p.split("=") as [string, string]));

/** Turn the markers back into inline styles / data attributes the editor schema understands; tidy page breaks. */
export function applyMarkers(html: string): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
  const texts = () => {
    const out: Text[] = [];
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) out.push(w.currentNode as Text);
    return out;
  };
  // Runs: only the common case where open/close markers land in one text node is restyled; strays are stripped.
  const runRe = new RegExp(`${R_OPEN}([^${R_MID}]*)${R_MID}([^${R_OPEN}${R_CLOSE}]*)${R_CLOSE}`);
  for (const node of texts()) {
    let cur: Text | null = node;
    while (cur) {
      const m = runRe.exec(cur.data);
      if (!m) break;
      const after = cur.splitText(m.index);
      const rest = after.splitText(m[0].length);
      const span = doc.createElement("span");
      const p = kv(m[1]!);
      if (p.s) span.style.fontSize = `${Number(p.s)}pt`;
      const hl = p.h && HIGHLIGHTS[p.h];
      span.textContent = m[2]!;
      let replacement: HTMLElement = span;
      if (hl) {
        const mark = doc.createElement("mark");
        mark.dataset.color = hl;
        mark.style.backgroundColor = hl;
        mark.textContent = m[2]!;
        if (p.s) {
          span.textContent = "";
          span.append(mark);
        } else replacement = mark;
      }
      after.replaceWith(replacement);
      cur = rest;
    }
  }
  for (const node of texts()) {
    const m = new RegExp(`${P_OPEN}([^${P_CLOSE}]*)${P_CLOSE}`).exec(node.data);
    if (m) {
      const block = node.parentElement?.closest<HTMLElement>("p,h1,h2,h3,h4,h5,h6,li,pre");
      if (block) {
        const p = kv(m[1]!);
        if (p.a) block.style.textAlign = p.a;
        if (p.i) block.dataset.indent = p.i;
      }
    }
    node.data = node.data.replace(new RegExp(`${P_OPEN}[^${P_CLOSE}]*${P_CLOSE}|${R_OPEN}[^${R_MID}]*${R_MID}|[\\uE000-\\uE004]`, "g"), "");
  }
  // mammoth emits <p><hr class="page-break"></p>, which HTML parsing turns into empty paragraphs around the break.
  const empty = (el: Element | null) => el?.tagName === "P" && !el.textContent?.trim() && !el.querySelector("img");
  for (const hr of doc.body.querySelectorAll("hr.page-break")) {
    if (empty(hr.previousElementSibling)) hr.previousElementSibling!.remove();
    if (empty(hr.nextElementSibling)) hr.nextElementSibling!.remove();
  }
  return doc.body.innerHTML;
}

export async function docxToHtml(buf: ArrayBuffer): Promise<{ html: string; warnings: string[] }> {
  const { default: mammoth } = await import("mammoth/mammoth.browser.js");
  const r = await mammoth.convertToHtml(
    { arrayBuffer: buf },
    { styleMap: STYLE_MAP, transformDocument: markDocument as (e: unknown) => unknown, convertImage: mammoth.images.dataUri },
  );
  return { html: applyMarkers(r.value), warnings: r.messages.filter((m) => m.type === "error").map((m) => m.message) };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function textToHtml(txt: string): string {
  return txt
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\r|\n/)
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join("");
}

/** Pasted / opened HTML: the editor schema drops unknown markup; this also removes anything that could fetch remotely. */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,link,meta,iframe,object,embed,frame,frameset,base,template,noscript,svg,math,form").forEach((n) => n.remove());
  for (const el of doc.body.querySelectorAll("*")) {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name) || a.name === "srcset") el.removeAttribute(a.name);
  }
  // Remote images would be blocked by COEP/CSP anyway, and fetching them would leak the visit.
  doc.querySelectorAll("img").forEach((img) => {
    if (!/^data:image\//i.test(img.getAttribute("src") ?? "")) img.remove();
  });
  return doc.body.innerHTML;
}

const extOf = (name: string) => (name.split(".").pop() ?? "").toLowerCase();

export async function fileToHtml(file: File, onProgress: ProgressFn, signal: AbortSignal): Promise<{ html: string; warnings: string[] }> {
  const ext = extOf(file.name);
  switch (ext) {
    case "docx":
      return docxToHtml(await file.arrayBuffer());
    case "txt":
    case "text":
      return { html: textToHtml(await file.text()), warnings: [] };
    case "html":
    case "htm":
      return { html: sanitizeHtml(await file.text()), warnings: [] };
    case "odt":
    case "rtf":
    case "doc": {
      if (!(await serverHas("document-convert"))) {
        throw new ImportError(`Opening .${ext} files needs our conversion server, which isn't available right now. Save the file as DOCX and open that instead.`);
      }
      const out = await runServerTool("document-convert", file, { format: "docx" }, onProgress, signal);
      return docxToHtml(await out.arrayBuffer());
    }
    case "pdf": {
      // The "pdf-to-docx" server tool (pdf2docx) is added to the registry separately; until the server
      // advertises it in /api/capabilities, PDFs are pointed at the PDF editor instead.
      if (!(await serverHas("pdf-to-docx"))) {
        throw new ImportError("Turning a PDF into an editable document needs our conversion server, which isn't available right now. To annotate a PDF instead, use the PDF editor.");
      }
      const out = await runServerTool("pdf-to-docx", file, {}, onProgress, signal);
      return docxToHtml(await out.arrayBuffer());
    }
    default:
      throw new ImportError(`.${ext || "?"} files can't be opened here. Supported: DOCX, ODT, RTF, DOC, TXT, HTML and PDF.`);
  }
}
