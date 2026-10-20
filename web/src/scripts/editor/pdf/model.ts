/**
 * Editor document model. Plain JSON (no DOM, no library objects) so a snapshot is a cheap structured clone and
 * undo/redo is just swapping snapshots.
 *
 * Coordinates: every overlay lives in its page's "base view" space — the page as the PDF itself displays it
 * (its own /Rotate applied), origin top-left, y down, 1 unit = 1 PDF point. A user rotation on top of that
 * rotates the page and its overlays together, so overlays never need re-projecting.
 */
export type FontFamily = "helvetica" | "times" | "courier";
export type Rotation = 0 | 90 | 180 | 270;

interface Base {
  id: string;
  x: number;
  y: number;
}

export interface TextOverlay extends Base {
  kind: "text";
  text: string;
  font: FontFamily;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
}

/** Rectangle-like overlays share a box. `whiteout` and `highlight` are rects with fixed styling semantics. */
export interface BoxOverlay extends Base {
  kind: "rect" | "ellipse" | "whiteout" | "highlight";
  w: number;
  h: number;
  /** Stroke colour, or "" for none. */
  stroke: string;
  /** Fill colour, or "" for none. */
  fill: string;
  strokeWidth: number;
}

/** A segment from (x, y) to (x + w, y + h); w/h may be negative. */
export interface LineOverlay extends Base {
  kind: "line" | "arrow";
  w: number;
  h: number;
  stroke: string;
  strokeWidth: number;
}

/** Freehand ink (also drawn signatures). Points are normalised 0..1 within the box so resizing just scales. */
export interface InkOverlay extends Base {
  kind: "ink";
  w: number;
  h: number;
  strokes: number[][];
  stroke: string;
  strokeWidth: number;
}

export interface ImageOverlay extends Base {
  kind: "image";
  w: number;
  h: number;
  /** Key into the editor's asset store (bytes are not part of snapshots). */
  asset: string;
}

export type Overlay = TextOverlay | BoxOverlay | LineOverlay | InkOverlay | ImageOverlay;

export interface PageModel {
  id: string;
  /** 0-based index of the page in the source PDF. */
  src: number;
  /** Extra rotation chosen in the editor, on top of the page's own /Rotate. */
  rotate: Rotation;
  overlays: Overlay[];
}

export interface DocModel {
  pages: PageModel[];
}

export interface Asset {
  bytes: Uint8Array;
  type: "png" | "jpg";
  url: string;
  width: number;
  height: number;
}

/** Facts about a source page, read once with pdf.js. */
export interface SourcePage {
  /** Size in base view space (points, page /Rotate applied). */
  width: number;
  height: number;
  /** The page's own /Rotate. */
  rotate: number;
  /** pdf.js viewport transform at scale 1 and the page's own rotation: PDF user space → base view space. */
  transform: [number, number, number, number, number, number];
}

let seq = 0;
export const uid = (p: string): string => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const clone = <T>(v: T): T => structuredClone(v);

export const LINE_HEIGHT = 1.2;

export const FONT_CSS: Record<FontFamily, string> = {
  helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  times: '"Times New Roman", Times, "Liberation Serif", serif',
  courier: '"Courier New", Courier, "Liberation Mono", monospace',
};

/** Axis-aligned bounds of an overlay in base view space. Text needs measured size, passed in. */
export function bounds(o: Overlay, textSize?: { w: number; h: number }): { x: number; y: number; w: number; h: number } {
  if (o.kind === "text") return { x: o.x, y: o.y, w: textSize?.w ?? o.size * 4, h: textSize?.h ?? o.size * LINE_HEIGHT };
  if (o.kind === "line" || o.kind === "arrow") {
    return { x: Math.min(o.x, o.x + o.w), y: Math.min(o.y, o.y + o.h), w: Math.abs(o.w), h: Math.abs(o.h) };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

export const rotDims = (w: number, h: number, r: number): { w: number; h: number } => (r % 180 === 0 ? { w, h } : { w: h, h: w });

export function describe(o: Overlay): string {
  switch (o.kind) {
    case "text":
      return `Text “${o.text.slice(0, 30) || "empty"}”`;
    case "rect":
      return "Rectangle";
    case "ellipse":
      return "Ellipse";
    case "whiteout":
      return "White-out";
    case "highlight":
      return "Highlight";
    case "line":
      return "Line";
    case "arrow":
      return "Arrow";
    case "ink":
      return "Drawing";
    case "image":
      return "Image";
  }
}

/** "#rrggbb" → [r, g, b] in 0..1. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1]!, 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
