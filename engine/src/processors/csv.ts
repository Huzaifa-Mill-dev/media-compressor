/**
 * RFC 4180 CSV parsing/serialisation. Pure (node-testable).
 *
 * NOTE: output is NOT formula-injection safe — cells beginning with = + - @ are written verbatim,
 * because escaping them would alter data for legitimate round-trips. Consumers opening CSV in
 * Excel from untrusted sources should be aware (see OWASP "CSV Injection").
 */

export type Cell = string | number | boolean | null;

/** Strip a UTF-8 BOM if present. */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Guess the delimiter from the first line (outside quotes): comma, semicolon, tab or pipe. */
export function detectDelimiter(text: string): string {
  const candidates = [",", ";", "\t", "|"];
  const counts = new Map<string, number>(candidates.map((c) => [c, 0]));
  let inQ = false;
  for (let i = 0; i < text.length && i < 64 * 1024; i++) {
    const ch = text[i]!;
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === "\n" || ch === "\r")) break;
    else if (!inQ && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best = ",";
  let bestN = 0;
  for (const [c, n] of counts) if (n > bestN) [best, bestN] = [c, n];
  return best;
}

export function parseCsv(input: string, delimiter?: string): string[][] {
  const text = stripBom(input);
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  let fieldStarted = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      i++;
      continue;
    }
    if (ch === d) {
      row.push(field);
      field = "";
      fieldStarted = false;
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStarted = false;
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++;
      continue;
    }
    field += ch;
    fieldStarted = true;
    i++;
  }
  if (inQuotes) throw new Error("Malformed CSV: unterminated quoted field.");
  if (fieldStarted || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function cellToString(v: Cell | Date | undefined): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return isNaN(v.getTime()) ? "" : v.toISOString();
  return String(v);
}

export function serializeCsv(rows: (Cell | Date | undefined)[][], opts: { bom?: boolean; delimiter?: string } = {}): string {
  const d = opts.delimiter ?? ",";
  const needs = new RegExp(`[${d === "\t" ? "\\t" : d.replace(/[\]\\^-]/g, "\\$&")}"\\r\\n]|^\\s|\\s$`);
  const lines = rows.map((r) =>
    r
      .map((v) => {
        const s = cellToString(v);
        return needs.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(d),
  );
  // CRLF per RFC 4180; BOM so Excel opens UTF-8 correctly.
  return (opts.bom === false ? "" : "﻿") + lines.join("\r\n") + (lines.length ? "\r\n" : "");
}

/** Interpret CSV text cells as numbers/booleans where unambiguous (for xlsx/json output). */
export function inferCell(s: string): Cell {
  if (s === "") return null;
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  if (s === "TRUE" || s === "true") return true;
  if (s === "FALSE" || s === "false") return false;
  return s;
}

/** Rows (first row = header) → array of objects. Duplicate/empty headers get suffixes. */
export function rowsToObjects(rows: Cell[][]): Record<string, Cell>[] {
  if (rows.length === 0) return [];
  const seen = new Map<string, number>();
  const header = rows[0]!.map((h, i) => {
    let k = h === null || h === "" ? `column${i + 1}` : String(h);
    const c = seen.get(k) ?? 0;
    seen.set(k, c + 1);
    if (c > 0) k = `${k}_${c + 1}`;
    return k;
  });
  return rows.slice(1).map((r) => {
    const o: Record<string, Cell> = {};
    header.forEach((k, i) => (o[k] = r[i] ?? null));
    return o;
  });
}

/** JSON (array of objects, or array of arrays) → rows. */
export function jsonToRows(data: unknown): Cell[][] {
  const norm = (v: unknown): Cell => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    return JSON.stringify(v);
  };
  let arr: unknown = data;
  if (arr && typeof arr === "object" && !Array.isArray(arr)) {
    // { sheetName: [...] } or a single object → first array value, else wrap
    const firstArray = Object.values(arr).find(Array.isArray);
    arr = firstArray ?? [arr];
  }
  if (!Array.isArray(arr)) throw new Error("JSON must be an array of objects or an array of arrays.");
  if (arr.every(Array.isArray)) return (arr as unknown[][]).map((r) => r.map(norm));
  const keys: string[] = [];
  const keySet = new Set<string>();
  for (const o of arr) {
    if (o && typeof o === "object") {
      for (const k of Object.keys(o)) if (!keySet.has(k)) (keySet.add(k), keys.push(k));
    }
  }
  if (keys.length === 0) return (arr as unknown[]).map((v) => [norm(v)]);
  return [keys, ...(arr as Record<string, unknown>[]).map((o) => keys.map((k) => norm(o?.[k])))];
}
