import { EngineError } from "./errors";

/**
 * Parse a page-range expression like "1-3, 5, 8-10, 12-end" into 1-based inclusive ranges.
 * Each comma-separated entry becomes one output document. Reversed ranges ("5-3") are
 * accepted and produce pages in descending order. Throws EngineError on invalid input.
 */
export function parseRanges(expr: string, pageCount: number): { from: number; to: number }[] {
  if (pageCount < 1) throw new EngineError("bad-range", "The document has no pages.");
  const parts = expr
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new EngineError("bad-range", "Enter at least one page or range, e.g. 1-3, 5.");
  if (parts.length > 1000) throw new EngineError("bad-range", "Too many ranges (max 1000).");
  const page = (s: string, part: string): number => {
    const t = s.trim().toLowerCase();
    if (t === "end" || t === "last" || t === "$") return pageCount;
    if (!/^\d+$/.test(t)) throw new EngineError("bad-range", `Invalid page "${part}".`);
    const n = Number(t);
    if (n < 1 || n > pageCount) {
      throw new EngineError("bad-range", `Page ${n} is out of range (document has ${pageCount} page${pageCount === 1 ? "" : "s"}).`);
    }
    return n;
  };
  return parts.map((part) => {
    const m = part.split(/\s*[-–]\s*/);
    if (m.length === 1) {
      const p = page(m[0]!, part);
      return { from: p, to: p };
    }
    if (m.length === 2) {
      const from = m[0] === "" ? 1 : page(m[0]!, part);
      const to = m[1] === "" ? pageCount : page(m[1]!, part);
      return { from, to };
    }
    throw new EngineError("bad-range", `Invalid range "${part}".`);
  });
}

/** Expand a range into the list of 0-based page indices. */
export function rangeIndices(r: { from: number; to: number }): number[] {
  const out: number[] = [];
  const step = r.from <= r.to ? 1 : -1;
  for (let p = r.from; step > 0 ? p <= r.to : p >= r.to; p += step) out.push(p - 1);
  return out;
}
