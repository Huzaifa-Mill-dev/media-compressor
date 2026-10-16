import { afterAll, describe, expect, it } from "vitest";
import { ascii, fixture, head, newEngine } from "./helpers";

const engine = newEngine(2);
afterAll(() => engine.dispose());

describe("pdf (browser)", () => {
  it("merge a(3)+b(1) -> valid pdf with 4 pages", async () => {
    const r = await engine.run({ toolId: "pdf-merge", files: [await fixture("a.pdf"), await fixture("b.pdf")], options: {} });
    expect(ascii(await head(r.outputs[0]!.blob, 5))).toBe("%PDF-");
    expect(r.meta?.pages).toBe(4);
  });
  it("split every page -> 3 outputs", async () => {
    const r = await engine.run({ toolId: "pdf-split", files: [await fixture("a.pdf")], options: { mode: "every" } });
    expect(r.outputs).toHaveLength(3);
  });
  it("split by range 2-3 -> pdf", async () => {
    const r = await engine.run({ toolId: "pdf-split", files: [await fixture("a.pdf")], options: { mode: "ranges", ranges: "2-3" } });
    expect(ascii(await head(r.outputs[0]!.blob, 5))).toBe("%PDF-");
  });
  it("images -> pdf", async () => {
    const r = await engine.run({ toolId: "images-to-pdf", files: [await fixture("flat.png"), await fixture("opt.jpg")], options: { pageSize: "a4", margin: 10 } });
    expect(ascii(await head(r.outputs[0]!.blob, 5))).toBe("%PDF-");
    expect(r.meta?.pages).toBe(2);
  });
  it("pdf -> png images (one per page)", async () => {
    const r = await engine.run({ toolId: "pdf-to-images", files: [await fixture("a.pdf")], options: { format: "png", dpi: 72 } });
    expect(r.outputs).toHaveLength(3);
    expect([...(await head(r.outputs[0]!.blob, 4))]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
  it("corrupt pdf fails cleanly", async () => {
    const bad = new File([new Uint8Array(500).fill(65)], "x.pdf");
    await expect(engine.run({ toolId: "pdf-merge", files: [bad, bad], options: {} })).rejects.toThrow();
  });
});

describe("font (browser)", () => {
  it("ttf -> woff -> woff2 have the right signatures", async () => {
    const ttf = await fixture("font.ttf");
    const w1 = await engine.run({ toolId: "font-convert", files: [ttf], options: { format: "woff" } });
    expect(ascii(await head(w1.outputs[0]!.blob, 4))).toBe("wOFF");
    const w2 = await engine.run({ toolId: "font-convert", files: [ttf], options: { format: "woff2" } });
    expect(ascii(await head(w2.outputs[0]!.blob, 4))).toBe("wOF2");
    expect(w2.outputs[0]!.size).toBeLessThan(ttf.size);
  });
});

describe("spreadsheet (browser)", () => {
  it("csv -> xlsx (zip) and xlsx -> json", async () => {
    const x = await engine.run({ toolId: "spreadsheet-convert", files: [await fixture("sheet.csv")], options: { format: "xlsx" } });
    expect(ascii(await head(x.outputs[0]!.blob, 2))).toBe("PK");
    const j = await engine.run({ toolId: "spreadsheet-convert", files: [await fixture("book.xlsx")], options: { format: "json" } });
    const txt = await j.outputs[0]!.blob.text();
    expect(JSON.parse(txt)).toBeTruthy();
    expect(txt).toContain("x, y");
  });
  it("csv round-trip keeps quoted newline and unicode", async () => {
    const x = await engine.run({ toolId: "spreadsheet-convert", files: [await fixture("sheet.csv")], options: { format: "xlsx" } });
    const back = await engine.run({ toolId: "spreadsheet-convert", files: [new File([x.outputs[0]!.blob], "r.xlsx")], options: { format: "csv" } });
    const t = await back.outputs[0]!.blob.text();
    expect(t).toContain("Élodie");
    expect(t).toContain("second line");
  });
});
