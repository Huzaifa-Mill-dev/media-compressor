/** spreadsheet-convert in the browser: xlsx / csv / json ↔ each other (exceljs, lazy). */
import { EngineError } from "../errors";
import { baseName, extOf, mimeOf, safeName, sniff } from "../formats";
import type { ProcCtx, ProcResult } from "../protocol";
import { inferCell, jsonToRows, parseCsv, rowsToObjects, serializeCsv, type Cell } from "./csv";

interface Sheet {
  name: string;
  rows: Cell[][];
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Legacy Excel CSVs are usually windows-1252.
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

type ExcelLib = typeof import("exceljs");
async function loadExcel(): Promise<ExcelLib> {
  const m = (await import("exceljs")) as unknown as ExcelLib & { default?: ExcelLib };
  return (m.default ?? m) as ExcelLib;
}

/** Excel cell value → plain scalar (formula results, rich text, hyperlinks, dates, errors). */
function plain(v: unknown): Cell | Date {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return plain(o.result);
    if ("richText" in o && Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join("");
    if ("text" in o) return plain(o.text);
    if ("error" in o) return String(o.error);
    if ("hyperlink" in o) return String(o.hyperlink);
  }
  return String(v);
}

async function readXlsx(bytes: Uint8Array): Promise<Sheet[]> {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch (e) {
    throw new EngineError("corrupt", `This doesn't look like a valid .xlsx file, or it is corrupt (${(e as Error).message.slice(0, 100)}).`);
  }
  const sheets: Sheet[] = [];
  wb.eachSheet((ws) => {
    const rows: Cell[][] = [];
    const maxCol = ws.columnCount;
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: (Cell | Date)[] = [];
      for (let c = 1; c <= maxCol; c++) cells.push(plain(row.getCell(c).value));
      rows.push(cells as Cell[]);
    }
    // Trim trailing fully-empty rows.
    while (rows.length && rows[rows.length - 1]!.every((c) => c === null || c === "")) rows.pop();
    sheets.push({ name: ws.name, rows });
  });
  if (sheets.length === 0) throw new EngineError("corrupt", "The workbook contains no sheets.");
  return sheets;
}

async function writeXlsx(sheets: Sheet[]): Promise<Uint8Array> {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const used = new Set<string>();
  for (const s of sheets) {
    let name = s.name.replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || "Sheet1";
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${name.slice(0, 28)}_${n}`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);
    for (const r of s.rows) ws.addRow(r.map((c) => (c === null ? null : c)));
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

function dateIso(d: Date): string {
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

export async function processSheet(ctx: ProcCtx): Promise<ProcResult> {
  const file = ctx.files[0];
  if (!file) throw new EngineError("no-input", "No file selected.");
  const target = String(ctx.options.format ?? "csv");
  const which = String(ctx.options.sheets ?? "first");
  const ext = extOf(file.name) || sniff(new Uint8Array(await file.slice(0, 16).arrayBuffer())) || "";
  ctx.progress("processing", 8, "Reading");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) throw new EngineError("empty", `${file.name} is empty (0 bytes).`);

  let sheets: Sheet[];
  if (ext === "xlsx") {
    if (sniff(bytes) !== "zip") throw new EngineError("corrupt", `${file.name} isn't a valid .xlsx file.`);
    sheets = await readXlsx(bytes);
  } else if (ext === "csv") {
    let rows: string[][];
    try {
      rows = parseCsv(decodeText(bytes));
    } catch (e) {
      throw new EngineError("corrupt", `${file.name}: ${(e as Error).message}`);
    }
    // Keep text verbatim for csv→csv; infer numbers/booleans only when a typed target needs them.
    const typed = target === "xlsx" || target === "json";
    sheets = [{ name: "Sheet1", rows: rows.map((r) => r.map((c) => (typed ? inferCell(c) : c))) }];
  } else if (ext === "json") {
    let data: unknown;
    try {
      data = JSON.parse(decodeText(bytes).replace(/^﻿/, ""));
    } catch (e) {
      throw new EngineError("corrupt", `${file.name} isn't valid JSON (${(e as Error).message.slice(0, 80)}).`);
    }
    try {
      if (data && typeof data === "object" && !Array.isArray(data) && Object.values(data).length > 1 && Object.values(data).every(Array.isArray)) {
        sheets = Object.entries(data as Record<string, unknown>).map(([name, v]) => ({ name, rows: jsonToRows(v) }));
      } else sheets = [{ name: "Sheet1", rows: jsonToRows(data) }];
    } catch (e) {
      throw new EngineError("corrupt", `${file.name}: ${(e as Error).message}`);
    }
  } else {
    throw new EngineError("browser-unsupported", `Reading .${ext} spreadsheets needs our server.`);
  }

  ctx.progress("processing", 55, "Converting");
  const selected = which === "all" ? sheets : [sheets[0]!];
  const base = baseName(file.name);
  const outputs: ProcResult["outputs"] = [];
  const multi = selected.length > 1;
  const nameFor = (s: Sheet, e: string) => safeName(multi ? `${base}-${s.name}.${e}` : `${base}.${e}`);

  if (target === "xlsx") {
    const out = await writeXlsx(sheets);
    const blob = new Blob([out as BlobPart], { type: mimeOf("xlsx") });
    outputs.push({ blob, filename: safeName(`${base}.xlsx`), mime: mimeOf("xlsx"), size: blob.size });
  } else if (target === "csv") {
    for (const s of selected) {
      const text = serializeCsv(s.rows.map((r) => r.map((c) => ((c as unknown) instanceof Date ? dateIso(c as unknown as Date) : c))), { bom: true });
      const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
      outputs.push({ blob, filename: nameFor(s, "csv"), mime: "text/csv", size: blob.size });
    }
  } else if (target === "json") {
    for (const s of selected) {
      const objs = rowsToObjects(s.rows.map((r) => r.map((c) => ((c as unknown) instanceof Date ? dateIso(c as unknown as Date) : c))));
      const blob = new Blob([JSON.stringify(objs, null, 2)], { type: "application/json" });
      outputs.push({ blob, filename: nameFor(s, "json"), mime: "application/json", size: blob.size });
    }
  } else {
    throw new EngineError("browser-unsupported", `Converting to ${target.toUpperCase()} needs our server.`);
  }
  return {
    outputs,
    meta: { codec: target, sheets: sheets.map((s) => s.name), rows: selected[0]?.rows.length ?? 0 },
  };
}
