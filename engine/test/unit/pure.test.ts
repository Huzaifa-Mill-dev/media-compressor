import { describe, expect, it } from "vitest";
import { tools, toolsById } from "../../src/tools";
import { planJob } from "../../src/routing";
import { normalizeOptions, defaultsFor, isValidValue } from "../../src/options";
import { Scheduler } from "../../src/scheduler";
import { parseRanges } from "../../src/ranges";
import { parseCsv, serializeCsv } from "../../src/processors/csv";
import { encodeWoff, decodeWoff } from "../../src/processors/woff";
import { fitWithin, looksTruncated } from "../../src/processors/imageprobe";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ALL = ["image-compress","image-convert","video-compress","video-convert","video-to-audio","audio-convert","audio-compress","font-convert","pdf-compress","pdf-merge","pdf-split","pdf-to-images","images-to-pdf","document-convert","spreadsheet-convert"];
const env = { webCodecs: true, wasm: true, workers: true, offscreenCanvas: true, crossOriginIsolated: true };
const fi = (name: string, size = 1000) => ({ name, size });

describe("registry integrity", () => {
  it("has every ToolId exactly once with unique slugs", () => {
    expect(tools.map((t) => t.id).sort()).toEqual([...ALL].sort());
    expect(new Set(tools.map((t) => t.slug)).size).toBe(tools.length);
  });
  it("defaults are valid and showIf refs exist", () => {
    for (const t of tools) {
      const keys = new Set(t.options.map((o) => o.key));
      expect(keys.size).toBe(t.options.length);
      for (const o of t.options) {
        if (o.showIf) expect(keys.has(o.showIf.key), `${t.id}.${o.key}`).toBe(true);
        if ("default" in o && o.default !== undefined) expect(isValidValue(o, o.default), `${t.id}.${o.key}`).toBe(true);
        if (o.type === "select") expect(o.choices.some((c) => c.value === o.default)).toBe(true);
      }
      expect(() => normalizeOptions(t, defaultsFor(t))).not.toThrow();
      expect(t.runtimes.length).toBeGreaterThan(0);
    }
  });
  it("rejects bad option values", () => {
    expect(() => normalizeOptions(toolsById["image-convert"], { format: "exe" })).toThrow();
    expect(() => normalizeOptions(toolsById["image-convert"], { quality: 500 })).toThrow();
  });
});

describe("routing", () => {
  const server = { tools: ["pdf-compress", "document-convert"] as never[] };
  it("browser for images, server for server-only tools", () => {
    expect(planJob(toolsById["image-compress"], [fi("a.jpg")], {}, env, null)).toEqual({ runtime: "browser" });
    expect(planJob(toolsById["pdf-compress"], [fi("a.pdf")], {}, env, server)).toEqual({ runtime: "server" });
  });
  it("null + reason when the server lacks the tool or is offline", () => {
    const r = planJob(toolsById["pdf-compress"], [fi("a.pdf")], {}, env, { tools: [] });
    expect(r.runtime).toBeNull();
    expect((r as { reason: string }).reason.length).toBeGreaterThan(10);
    expect(planJob(toolsById["document-convert"], [fi("a.docx")], {}, env, null).runtime).toBeNull();
  });
  it("oversize / zero-byte / wrong extension", () => {
    expect(planJob(toolsById["image-compress"], [fi("a.jpg", 200e6)], {}, env, null).runtime).toBeNull();
    expect(planJob(toolsById["image-compress"], [fi("a.jpg", 0)], {}, env, null).runtime).toBeNull();
    expect(planJob(toolsById["image-compress"], [fi("a.exe")], {}, env, null).runtime).toBeNull();
  });
  it("spreadsheet/font split by format", () => {
    expect(planJob(toolsById["spreadsheet-convert"], [fi("a.xlsx")], { format: "csv" }, env, null)).toEqual({ runtime: "browser" });
    expect(planJob(toolsById["spreadsheet-convert"], [fi("a.xls")], { format: "csv" }, env, { tools: ["spreadsheet-convert"] as never[] })).toEqual({ runtime: "server" });
  });
});

describe("scheduler", () => {
  it("bounds concurrency and finishes all 10", async () => {
    const s = new Scheduler({ limit: 3 });
    let cur = 0, peak = 0;
    const jobs = Array.from({ length: 10 }, () => s.schedule("l", async () => { cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 20)); cur--; return 1; }));
    expect((await Promise.all(jobs)).length).toBe(10);
    expect(peak).toBeLessThanOrEqual(3);
  });
  it("abort frees the slot (queued and running)", async () => {
    const s = new Scheduler({ limit: 1 });
    const ac = new AbortController();
    const running = s.schedule("l", (sig) => new Promise((_, rej) => sig.addEventListener("abort", () => rej(new Error("x")))), { signal: ac.signal });
    const queuedAc = new AbortController();
    const queued = s.schedule("l", async () => 1, { signal: queuedAc.signal });
    const next = s.schedule("l", async () => 2);
    queuedAc.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    ac.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(await next).toBe(2);
    expect(s.runningCount).toBe(0);
  });
});

describe("ranges / csv / probe", () => {
  it("ranges", () => {
    expect(parseRanges("1-3, 5, 8-end", 10)).toEqual([{ from: 1, to: 3 }, { from: 5, to: 5 }, { from: 8, to: 10 }]);
    expect(() => parseRanges("11", 10)).toThrow();
    expect(() => parseRanges("a", 10)).toThrow();
    expect(() => parseRanges("", 10)).toThrow();
  });
  it("csv quoting round-trips with BOM", () => {
    const rows = [["a,b", 'q"t', "line\nbreak", " pad "], ["1", "", "é", "x"]];
    const text = serializeCsv(rows);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(parseCsv(text)).toEqual(rows);
  });
  it("fitWithin never upscales", () => {
    expect(fitWithin(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(100, 100, 2000, 2000)).toEqual({ width: 100, height: 100 });
  });
  it("detects truncated jpeg", () => {
    const j = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect(looksTruncated(j, j, j.length, "jpg")).toBe(true);
  });
});

describe("WOFF1 vs fontTools", () => {
  it("round-trips and validates", () => {
    const ttf = readFileSync(join(__dirname, "../fixtures/font.ttf"));
    const woff = encodeWoff(new Uint8Array(ttf));
    expect(woff.length).toBeLessThan(ttf.length);
    const dir = mkdtempSync(join(tmpdir(), "woff-"));
    writeFileSync(join(dir, "o.woff"), woff);
    const py = "import sys;from fontTools.ttLib import TTFont;f=TTFont(sys.argv[1]);assert f.flavor=='woff';print(len(f.getGlyphOrder()), f['head'].checkSumAdjustment>0); f2=TTFont(sys.argv[2]);assert sorted(f.keys())==sorted(f2.keys())";
    const out = execFileSync(process.platform === "win32" ? "python" : "python3", [...(process.platform === "win32" ? [] : ["-I"]), "-c", py, join(dir, "o.woff"), join(__dirname, "../fixtures/font.ttf")]).toString();
    expect(out).toMatch(/True/);
    const back = decodeWoff(woff);
    expect(back.length).toBeGreaterThan(ttf.length * 0.99);
  });
});
