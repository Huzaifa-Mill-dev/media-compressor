/** Shape geometry shared by the on-screen SVG preview and the PDF writer, so both draw exactly the same thing. */
import type { InkOverlay } from "./model";

type Pt = [number, number];

/** Arrow: the shaft stops at the base of the head so a thick line doesn't poke through the tip. */
export function arrowGeometry(x1: number, y1: number, x2: number, y2: number, width: number): { shaftEnd: Pt; head: [Pt, Pt, Pt] } {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const headLen = Math.min(len, Math.max(10, width * 4));
  const headHalf = Math.max(5, width * 2.4);
  const bx = x2 - ux * headLen;
  const by = y2 - uy * headLen;
  return {
    shaftEnd: [bx + ux * Math.min(1, headLen / 2), by + uy * Math.min(1, headLen / 2)],
    head: [
      [x2, y2],
      [bx - uy * headHalf, by + ux * headHalf],
      [bx + uy * headHalf, by - ux * headHalf],
    ],
  };
}

/** Four cubic Béziers approximating an ellipse inscribed in the box. Returns [start, ...[c1, c2, end] × 4]. */
export function ellipseCurves(x: number, y: number, w: number, h: number): { start: Pt; curves: [Pt, Pt, Pt][] } {
  const k = 0.5522847498;
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  return {
    start: [cx + rx, cy],
    curves: [
      [[cx + rx, cy + ry * k], [cx + rx * k, cy + ry], [cx, cy + ry]],
      [[cx - rx * k, cy + ry], [cx - rx, cy + ry * k], [cx - rx, cy]],
      [[cx - rx, cy - ry * k], [cx - rx * k, cy - ry], [cx, cy - ry]],
      [[cx + rx * k, cy - ry], [cx + rx, cy - ry * k], [cx + rx, cy]],
    ],
  };
}

/** Ink strokes in absolute base-view coordinates. */
export function inkPoints(o: InkOverlay): Pt[][] {
  return o.strokes.map((s) => {
    const pts: Pt[] = [];
    for (let i = 0; i + 1 < s.length; i += 2) pts.push([o.x + s[i]! * o.w, o.y + s[i + 1]! * o.h]);
    return pts;
  });
}

/** Smooth a polyline into quadratic segments through midpoints: [start, ...[ctrl, end]]. */
export function smoothPath(pts: Pt[]): { start: Pt; quads: [Pt, Pt][] } | null {
  if (pts.length === 0) return null;
  const start = pts[0]!;
  const quads: [Pt, Pt][] = [];
  if (pts.length === 1) return { start, quads: [[start, [start[0] + 0.01, start[1]]]] };
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const n = pts[i + 1]!;
    quads.push([p, [(p[0] + n[0]) / 2, (p[1] + n[1]) / 2]]);
  }
  const last = pts[pts.length - 1]!;
  quads.push([last, last]);
  return { start, quads };
}

/** SVG path data for ink, in the coordinates given. */
export function inkSvgPath(strokes: Pt[][]): string {
  const f = (n: number) => Math.round(n * 100) / 100;
  return strokes
    .map((s) => {
      const p = smoothPath(s);
      if (!p) return "";
      return `M${f(p.start[0])} ${f(p.start[1])}` + p.quads.map(([c, e]) => `Q${f(c[0])} ${f(c[1])} ${f(e[0])} ${f(e[1])}`).join("");
    })
    .join("");
}

/** Normalise absolute strokes into a box (with padding for the stroke width) for an InkOverlay. */
export function normaliseInk(strokes: Pt[][], pad: number): { x: number; y: number; w: number; h: number; strokes: number[][] } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes)
    for (const [x, y] of s) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  minX -= pad;
  minY -= pad;
  const w = Math.max(1, maxX + pad - minX);
  const h = Math.max(1, maxY + pad - minY);
  const r = (n: number) => Math.round(n * 10000) / 10000;
  return { x: minX, y: minY, w, h, strokes: strokes.map((s) => s.flatMap(([x, y]) => [r((x - minX) / w), r((y - minY) / h)])) };
}
