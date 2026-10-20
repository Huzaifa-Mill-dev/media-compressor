/**
 * Writes the editor model into the ORIGINAL PDF with pdf-lib. Existing page content is left byte-for-byte as it
 * was (wrapped in q/Q so its graphics state can't leak); overlays are appended as real vector operators: text
 * with the standard-14 fonts, paths for shapes and ink, image XObjects for pictures. Nothing is rasterised.
 */
import { loadPdfLib, type PdfLib } from "../../../../../engine/src/pdf-libs";
import { arrowGeometry, ellipseCurves, inkPoints, smoothPath } from "./geometry";
import { FONT_CSS, hexToRgb, LINE_HEIGHT, type Asset, type DocModel, type FontFamily, type Overlay, type SourcePage, type TextOverlay } from "./model";

type PDFDocument = PdfLib["PDFDocument"]["prototype"];
type PDFPage = PdfLib["PDFPage"]["prototype"];
type PDFFont = PdfLib["PDFFont"]["prototype"];
type PDFImage = PdfLib["PDFImage"]["prototype"];
type PDFOperator = PdfLib["PDFOperator"]["prototype"];
type PDFName = PdfLib["PDFName"]["prototype"];
type StandardFont = PdfLib["StandardFonts"][keyof PdfLib["StandardFonts"]];

export interface ExportResult {
  bytes: Uint8Array;
  /** Characters the standard PDF fonts can't encode, replaced with "?". */
  replacedChars: number;
}

const STD: Record<FontFamily, [string, string, string, string]> = {
  // regular, bold, italic, bold-italic
  helvetica: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  times: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
  courier: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};

/**
 * Where the first baseline sits below the top of a text box, as a fraction of the font size — computed the way CSS
 * lays out a line box (half-leading + ascent) with the same font the editor showed, so the PDF text lands exactly
 * where it was on screen.
 */
const baselineCache = new Map<string, number>();
export function baselineRatio(o: Pick<TextOverlay, "font" | "bold" | "italic">): number {
  const key = `${o.font}${o.bold}${o.italic}`;
  const hit = baselineCache.get(key);
  if (hit !== undefined) return hit;
  let ratio = (LINE_HEIGHT - 1.15) / 2 + 0.92;
  try {
    const g = document.createElement("canvas").getContext("2d");
    if (g) {
      g.font = `${o.italic ? "italic " : ""}${o.bold ? "bold " : ""}100px ${FONT_CSS[o.font]}`;
      const m = g.measureText("Hg");
      const a = m.fontBoundingBoxAscent;
      const d = m.fontBoundingBoxDescent;
      if (a > 0 && d >= 0) ratio = ((LINE_HEIGHT * 100 - (a + d)) / 2 + a) / 100;
    }
  } catch {
    /* keep the estimate */
  }
  baselineCache.set(key, ratio);
  return ratio;
}

export function invert([a, b, c, d, e, f]: number[]): [number, number, number, number, number, number] {
  const det = a! * d! - b! * c! || 1;
  return [d! / det, -b! / det, -c! / det, a! / det, (c! * f! - d! * e!) / det, (b! * e! - a! * f!) / det];
}

export async function exportPdf(original: Uint8Array, model: DocModel, sources: SourcePage[], assets: Map<string, Asset>): Promise<ExportResult> {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(original, { updateMetadata: false });
  const fonts = new Map<string, PDFFont>();
  const images = new Map<string, PDFImage>();
  let replacedChars = 0;

  const origPages = doc.getPages();
  // Rebuild the page tree in the editor's order (drops deleted pages; a page used once keeps all its objects).
  for (let i = origPages.length - 1; i >= 0; i--) doc.removePage(i);
  model.pages.forEach((pm, i) => {
    const page = origPages[pm.src];
    if (!page) throw new Error(`Source page ${pm.src + 1} is missing.`);
    doc.insertPage(i, page);
  });

  for (const pm of model.pages) {
    const page = origPages[pm.src]!;
    const src = sources[pm.src]!;
    const rot = (((src.rotate + pm.rotate) % 360) + 360) % 360;
    if (pm.rotate) page.setRotation(lib.degrees(rot));
    if (pm.overlays.length === 0) continue;

    // Isolate the original content, then draw in base-view space (y down, points) via the inverse viewport matrix.
    const pre = doc.context.register(doc.context.contentStream([lib.pushGraphicsState()]));
    const post = doc.context.register(doc.context.contentStream([lib.popGraphicsState()]));
    if (!page.node.wrapContentStreams(pre, post)) {
      page.node.normalize();
      page.node.wrapContentStreams(pre, post);
    }
    const ops: PDFOperator[] = [lib.pushGraphicsState(), lib.concatTransformationMatrix(...invert(src.transform))];
    for (const o of pm.overlays) {
      const r = await drawOverlay(lib, doc, page, o, fonts, images, assets);
      ops.push(...r.ops);
      replacedChars += r.replaced;
    }
    ops.push(lib.popGraphicsState());
    page.pushOperators(...ops);
  }

  const bytes = await doc.save();
  return { bytes, replacedChars };
}

function gsKey(doc: PDFDocument, page: PDFPage, opacity: number, blend?: string): PDFName {
  const dict = doc.context.obj({ Type: "ExtGState", ca: opacity, CA: opacity, ...(blend ? { BM: blend } : {}) });
  return page.node.newExtGState("GS", doc.context.register(dict));
}

async function drawOverlay(
  lib: PdfLib,
  doc: PDFDocument,
  page: PDFPage,
  o: Overlay,
  fonts: Map<string, PDFFont>,
  images: Map<string, PDFImage>,
  assets: Map<string, Asset>,
): Promise<{ ops: PDFOperator[]; replaced: number }> {
  const ops: PDFOperator[] = [lib.pushGraphicsState()];
  const fillRgb = (c: string) => lib.setFillingRgbColor(...hexToRgb(c));
  const strokeRgb = (c: string) => lib.setStrokingRgbColor(...hexToRgb(c));
  let replaced = 0;

  switch (o.kind) {
    case "text": {
      const name = STD[o.font][(o.bold ? 1 : 0) + (o.italic ? 2 : 0)]!;
      let font = fonts.get(name);
      if (!font) {
        font = doc.embedStandardFont(name as StandardFont);
        fonts.set(name, font);
      }
      const charset = new Set(font.getCharacterSet());
      const key = page.node.newFontDictionary(font.name, font.ref);
      const lh = o.size * LINE_HEIGHT;
      const base = baselineRatio(o) * o.size;
      ops.push(lib.beginText(), lib.setFontAndSize(key, o.size), fillRgb(o.color));
      o.text.split("\n").forEach((line, i) => {
        let safe = "";
        for (const ch of line.replace(/\t/g, "    ")) {
          if (charset.has(ch.codePointAt(0)!)) safe += ch;
          else {
            safe += "?";
            replaced++;
          }
        }
        if (!safe) return;
        // Flip y back so glyphs are upright in the y-down drawing space.
        ops.push(lib.setTextMatrix(1, 0, 0, -1, o.x, o.y + base + i * lh), lib.showText(font!.encodeText(safe)));
      });
      ops.push(lib.endText());
      break;
    }
    case "rect":
    case "whiteout":
    case "highlight": {
      const sw = o.stroke ? o.strokeWidth : 0;
      if (o.kind === "highlight") ops.push(lib.setGraphicsState(gsKey(doc, page, 0.4, "Multiply")));
      if (o.fill) ops.push(fillRgb(o.fill));
      if (sw) ops.push(strokeRgb(o.stroke), lib.setLineWidth(sw), lib.setLineJoin(lib.LineJoinStyle.Miter));
      ops.push(lib.rectangle(o.x + sw / 2, o.y + sw / 2, Math.max(0, o.w - sw), Math.max(0, o.h - sw)));
      ops.push(paint(lib, !!o.fill, !!sw));
      break;
    }
    case "ellipse": {
      const sw = o.stroke ? o.strokeWidth : 0;
      if (o.fill) ops.push(fillRgb(o.fill));
      if (sw) ops.push(strokeRgb(o.stroke), lib.setLineWidth(sw));
      const e = ellipseCurves(o.x + sw / 2, o.y + sw / 2, Math.max(0, o.w - sw), Math.max(0, o.h - sw));
      ops.push(lib.moveTo(...e.start));
      for (const [c1, c2, p] of e.curves) ops.push(lib.appendBezierCurve(...c1, ...c2, ...p));
      ops.push(lib.closePath(), paint(lib, !!o.fill, !!sw));
      break;
    }
    case "line":
    case "arrow": {
      const x2 = o.x + o.w;
      const y2 = o.y + o.h;
      ops.push(strokeRgb(o.stroke), fillRgb(o.stroke), lib.setLineWidth(o.strokeWidth), lib.setLineCap(lib.LineCapStyle.Round));
      if (o.kind === "line") {
        ops.push(lib.moveTo(o.x, o.y), lib.lineTo(x2, y2), lib.stroke());
      } else {
        const a = arrowGeometry(o.x, o.y, x2, y2, o.strokeWidth);
        ops.push(lib.moveTo(o.x, o.y), lib.lineTo(...a.shaftEnd), lib.stroke());
        ops.push(lib.moveTo(...a.head[0]), lib.lineTo(...a.head[1]), lib.lineTo(...a.head[2]), lib.closePath(), lib.fill());
      }
      break;
    }
    case "ink": {
      ops.push(strokeRgb(o.stroke), lib.setLineWidth(o.strokeWidth), lib.setLineCap(lib.LineCapStyle.Round), lib.setLineJoin(lib.LineJoinStyle.Round));
      for (const s of inkPoints(o)) {
        const p = smoothPath(s);
        if (!p) continue;
        ops.push(lib.moveTo(...p.start));
        for (const [c, e] of p.quads) ops.push(lib.appendQuadraticCurve(...c, ...e));
      }
      ops.push(lib.stroke());
      break;
    }
    case "image": {
      const a = assets.get(o.asset);
      if (!a) break;
      let img = images.get(o.asset);
      if (!img) {
        img = a.type === "png" ? await doc.embedPng(a.bytes) : await doc.embedJpg(a.bytes);
        images.set(o.asset, img);
      }
      const key = page.node.newXObject("Image", img.ref);
      // Image space is a unit square with row 0 at the top once y is flipped.
      ops.push(lib.concatTransformationMatrix(o.w, 0, 0, -o.h, o.x, o.y + o.h), lib.drawObject(key));
      break;
    }
  }
  ops.push(lib.popGraphicsState());
  return { ops, replaced };
}

function paint(lib: PdfLib, fill: boolean, stroke: boolean): PDFOperator {
  if (fill && stroke) return lib.fillAndStroke();
  if (fill) return lib.fill();
  if (stroke) return lib.stroke();
  return lib.endPath();
}
