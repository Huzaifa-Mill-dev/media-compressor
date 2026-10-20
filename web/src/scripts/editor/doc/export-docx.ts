/** Editor JSON (ProseMirror) → DOCX, entirely in the browser with the `docx` library. */
import type { JSONContent } from "@tiptap/core";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
  type ParagraphChild,
} from "docx";
import { HIGHLIGHTS } from "./highlights";

export type PageSize = "a4" | "letter";

/** Twips (1/1440 in). */
const PAGES: Record<PageSize, { width: number; height: number }> = {
  a4: { width: 11906, height: 16838 },
  letter: { width: 12240, height: 15840 },
};
const MARGIN = 1440;
const INDENT_TWIPS = 720;
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED } as const;
const HIGHLIGHT_BY_HEX = Object.fromEntries(Object.entries(HIGHLIGHTS).map(([k, v]) => [v, k])) as Record<string, IRunOptions["highlight"]>;

type Block = Paragraph | Table;
interface Ctx {
  /** Content width in twips (for images and table columns). */
  width: number;
  list?: { kind: "bullet" | "number"; level: number; instance: number };
  /** Next ordered-list instance, so each list restarts at 1. */
  seq: { n: number };
  quote?: boolean;
}

/** "#abc" / "rgb(1,2,3)" → "AABBCC". */
export function toHex(c: string | undefined | null): string | undefined {
  if (!c) return undefined;
  const s = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return m[1]!.split("").map((x) => x + x).join("").toUpperCase();
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return m[1]!.toUpperCase();
  const r = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s);
  if (r) return [r[1], r[2], r[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("").toUpperCase();
  return undefined;
}

/** "12pt" / "16px" → half-points. */
function halfPoints(size: unknown): number | undefined {
  const m = /^([\d.]+)(pt|px)?$/.exec(String(size ?? "").trim());
  if (!m) return undefined;
  const pt = m[2] === "px" ? Number(m[1]) * 0.75 : Number(m[1]);
  return pt > 0 ? Math.round(pt * 2) : undefined;
}

function runOptions(marks: JSONContent["marks"] = []): IRunOptions {
  const o: { -readonly [K in keyof IRunOptions]: IRunOptions[K] } = {};
  for (const m of marks) {
    const a = m.attrs ?? {};
    switch (m.type) {
      case "bold":
        o.bold = true;
        break;
      case "italic":
        o.italics = true;
        break;
      case "underline":
        o.underline = {};
        break;
      case "strike":
        o.strike = true;
        break;
      case "code":
        o.font = "Consolas";
        break;
      case "link":
        o.style = "Hyperlink";
        break;
      case "highlight": {
        const hex = toHex(a.color as string) ?? "FFFF00";
        const name = HIGHLIGHT_BY_HEX[`#${hex.toLowerCase()}`];
        if (name) o.highlight = name;
        else o.shading = { type: ShadingType.CLEAR, color: "auto", fill: hex };
        break;
      }
      case "textStyle": {
        const color = toHex(a.color as string);
        if (color) o.color = color;
        const size = halfPoints(a.fontSize);
        if (size) o.size = size;
        if (a.fontFamily) o.font = String(a.fontFamily).split(",")[0]!.replace(/["']/g, "").trim();
        break;
      }
    }
  }
  return o;
}

function inlines(nodes: JSONContent[] = []): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  let i = 0;
  while (i < nodes.length) {
    const n = nodes[i]!;
    const href = n.marks?.find((m) => m.type === "link")?.attrs?.href as string | undefined;
    if (href) {
      // Group consecutive text with the same link into one hyperlink.
      const runs: TextRun[] = [];
      while (i < nodes.length && nodes[i]!.marks?.find((m) => m.type === "link")?.attrs?.href === href) {
        runs.push(inlineRun(nodes[i]!));
        i++;
      }
      out.push(new ExternalHyperlink({ link: href, children: runs }));
      continue;
    }
    out.push(inlineRun(n));
    i++;
  }
  return out;
}

function inlineRun(n: JSONContent): TextRun {
  if (n.type === "hardBreak") return new TextRun({ break: 1 });
  return new TextRun({ text: n.text ?? "", ...runOptions(n.marks) });
}

interface ImgData {
  type: "png" | "jpg" | "gif";
  data: Uint8Array;
  width: number;
  height: number;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/** data: URL → bytes the docx lib accepts; formats Word can't take (WebP, SVG, AVIF…) are re-encoded as PNG. */
async function imageData(src: string): Promise<ImgData | null> {
  const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/i.exec(src);
  if (!m) return null;
  const img = await loadImage(src).catch(() => null);
  if (!img || !img.naturalWidth) return null;
  const fmt = m[1]!.toLowerCase();
  const type = fmt === "png" ? "png" : fmt === "jpeg" || fmt === "jpg" ? "jpg" : fmt === "gif" ? "gif" : null;
  let data: Uint8Array;
  if (type) data = Uint8Array.from(atob(m[2]!), (c) => c.charCodeAt(0));
  else {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d")!.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    if (!blob) return null;
    data = new Uint8Array(await blob.arrayBuffer());
  }
  return { type: type ?? "png", data, width: img.naturalWidth, height: img.naturalHeight };
}

function paragraphProps(node: JSONContent, ctx: Ctx) {
  const a = node.attrs ?? {};
  const align = ALIGN[a.textAlign as keyof typeof ALIGN];
  const indent = Number(a.indent) || 0;
  return {
    ...(align && a.textAlign !== "left" ? { alignment: align } : {}),
    ...(ctx.list
      ? { numbering: { reference: ctx.list.kind === "bullet" ? "mt-bullets" : "mt-numbers", level: Math.min(8, ctx.list.level), instance: ctx.list.instance } }
      : indent
        ? { indent: { left: indent * INDENT_TWIPS } }
        : {}),
  };
}

async function blocks(nodes: JSONContent[] = [], ctx: Ctx): Promise<Block[]> {
  const out: Block[] = [];
  for (const n of nodes) out.push(...(await block(n, ctx)));
  return out;
}

async function block(n: JSONContent, ctx: Ctx): Promise<Block[]> {
  switch (n.type) {
    case "paragraph":
      return [new Paragraph({ children: inlines(n.content), ...(ctx.quote ? { style: "Quote" } : {}), ...paragraphProps(n, ctx) })];
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level) || 1));
      return [new Paragraph({ heading: HEADINGS[level - 1], children: inlines(n.content), ...paragraphProps(n, ctx) })];
    }
    case "blockquote":
      return blocks(n.content, { ...ctx, quote: true });
    case "codeBlock": {
      const lines = (n.content ?? []).map((c) => c.text ?? "").join("").split("\n");
      return [new Paragraph({ style: "Code", children: lines.map((l, i) => new TextRun({ text: l, break: i ? 1 : 0 })) })];
    }
    case "bulletList":
    case "orderedList": {
      const kind = n.type === "bulletList" ? "bullet" : "number";
      const level = ctx.list ? ctx.list.level + 1 : 0;
      const instance = ctx.list && ctx.list.kind === kind ? ctx.list.instance : ++ctx.seq.n;
      const out: Block[] = [];
      for (const item of n.content ?? []) {
        let first = true;
        for (const child of item.content ?? []) {
          if (child.type === "bulletList" || child.type === "orderedList") {
            out.push(...(await block(child, { ...ctx, list: { kind, level, instance } })));
          } else if (first && child.type === "paragraph") {
            out.push(...(await block(child, { ...ctx, list: { kind, level, instance } })));
            first = false;
          } else {
            // Continuation paragraphs of a list item: indented, no bullet.
            out.push(...(await block({ ...child, attrs: { ...child.attrs, indent: level + 1 } }, { ...ctx, list: undefined })));
          }
        }
      }
      return out;
    }
    case "table": {
      const rows = n.content ?? [];
      const cols = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((s, c) => s + (Number(c.attrs?.colspan) || 1), 0)));
      const colW = Math.floor(ctx.width / cols);
      const trs: TableRow[] = [];
      for (const r of rows) {
        const cells: TableCell[] = [];
        const isHeader = (r.content ?? []).every((c) => c.type === "tableHeader");
        for (const c of r.content ?? []) {
          const span = Number(c.attrs?.colspan) || 1;
          const inner = await blocks(c.content, { ...ctx, list: undefined, width: colW * span });
          cells.push(
            new TableCell({
              children: inner.length ? inner : [new Paragraph({})],
              columnSpan: span > 1 ? span : undefined,
              rowSpan: Number(c.attrs?.rowspan) > 1 ? Number(c.attrs?.rowspan) : undefined,
              width: { size: colW * span, type: WidthType.DXA },
              ...(c.attrs?.backgroundColor && toHex(c.attrs.backgroundColor as string) ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: toHex(c.attrs.backgroundColor as string)! } } : {}),
            }),
          );
        }
        trs.push(new TableRow({ children: cells, tableHeader: isHeader || undefined }));
      }
      return [new Table({ rows: trs, width: { size: colW * cols, type: WidthType.DXA }, columnWidths: Array(cols).fill(colW) })];
    }
    case "image": {
      const img = await imageData(String(n.attrs?.src ?? ""));
      if (!img) return [];
      const maxPx = (ctx.width / 1440) * 96;
      const wantW = Number(n.attrs?.width) || img.width;
      const w = Math.min(wantW, maxPx);
      const h = (img.height / img.width) * w;
      const alt = String(n.attrs?.alt ?? "");
      return [
        new Paragraph({
          children: [new ImageRun({ type: img.type, data: img.data, transformation: { width: Math.round(w), height: Math.round(h) }, altText: alt ? { name: alt, description: alt, title: alt } : undefined })],
        }),
      ];
    }
    case "pageBreak":
      return [new Paragraph({ children: [new PageBreak()] })];
    case "horizontalRule":
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "auto", space: 1 } } })];
    default:
      return n.content ? blocks(n.content, ctx) : [];
  }
}

const levels = (kind: "bullet" | "number") =>
  Array.from({ length: 9 }, (_, level) => ({
    level,
    format: kind === "bullet" ? LevelFormat.BULLET : [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3]!,
    text: kind === "bullet" ? ["•", "◦", "▪"][level % 3]! : `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: INDENT_TWIPS * (level + 1), hanging: 360 } } },
  }));

export async function toDocx(json: JSONContent, opts: { title: string; page: PageSize }): Promise<Blob> {
  const page = PAGES[opts.page];
  const width = page.width - 2 * MARGIN;
  const children = await blocks(json.content, { width, seq: { n: 0 } });
  const doc = new Document({
    title: opts.title,
    creator: "Media Toolkit",
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
      paragraphStyles: [
        { id: "Quote", name: "Quote", basedOn: "Normal", run: { italics: true, color: "595959" }, paragraph: { indent: { left: INDENT_TWIPS } } },
        { id: "Code", name: "Code", basedOn: "Normal", run: { font: "Consolas", size: 20 }, paragraph: { shading: { type: ShadingType.CLEAR, color: "auto", fill: "F3F3F2" } } },
      ],
    },
    numbering: { config: [{ reference: "mt-bullets", levels: levels("bullet") }, { reference: "mt-numbers", levels: levels("number") }] },
    sections: [{ properties: { page: { size: page, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } } }, children: children.length ? children : [new Paragraph({})] }],
  });
  return Packer.toBlob(doc);
}
