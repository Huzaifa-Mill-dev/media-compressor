import { afterAll, describe, expect, it } from "vitest";
import { ascii, dims, fixture, head, newEngine } from "./helpers";

const engine = newEngine(3);
afterAll(() => engine.dispose());
const run = (name: string, options: Record<string, string | number>, toolId: "image-compress" | "image-convert" = "image-compress") =>
  fixture(name).then((f) => engine.run({ toolId, files: [f], options }));

describe("image compress/convert", () => {
  it("jpeg -> webp is valid and smaller", async () => {
    const r = await run("photo1.jpg", { format: "webp", quality: 80 });
    const h = await head(r.outputs[0]!.blob, 12);
    expect(ascii(h.slice(0, 4))).toBe("RIFF");
    expect(ascii(h.slice(8, 12))).toBe("WEBP");
    expect(r.outputs[0]!.size).toBeLessThan(r.inputSize);
  });
  it("png -> avif has ftyp box", async () => {
    const r = await run("small.png", { format: "avif", quality: 60 });
    expect(ascii((await head(r.outputs[0]!.blob, 12)).slice(4, 12))).toBe("ftypavif");
  });
  it("jpeg -> png and png -> jpeg magic", async () => {
    const png = await run("opt.jpg", { format: "png" }, "image-convert");
    expect([...(await head(png.outputs[0]!.blob, 4))]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const jpg = await run("flat.png", { format: "jpeg", quality: 80 }, "image-convert");
    expect([...(await head(jpg.outputs[0]!.blob, 3))]).toEqual([0xff, 0xd8, 0xff]);
  });
  it("never larger than the original (keeps original)", async () => {
    const r = await run("opt.jpg", { format: "original", quality: 100 });
    expect(r.outputs[0]!.size).toBeLessThanOrEqual(r.inputSize);
  });
  it("EXIF orientation is applied", async () => {
    const r = await run("rotated.jpg", { format: "png" }, "image-convert");
    expect(await dims(r.outputs[0]!.blob)).toEqual({ w: 200, h: 400 });
  });
  it("alpha preserved in webp", async () => {
    const r = await run("alpha.png", { format: "webp", quality: 90 });
    const bm = await createImageBitmap(r.outputs[0]!.blob);
    const c = new OffscreenCanvas(bm.width, bm.height).getContext("2d")!;
    c.drawImage(bm, 0, 0);
    expect(c.getImageData(0, 0, 1, 1).data[3]).toBe(0);
    expect(c.getImageData(150, 100, 1, 1).data[3]).toBeGreaterThan(0);
  });
  it("resize respects max width and never upscales", async () => {
    const r = await run("small.png", { format: "webp", width: 400 });
    expect((await dims(r.outputs[0]!.blob)).w).toBe(400);
    const r2 = await run("small.png", { format: "webp", width: 5000 });
    expect((await dims(r2.outputs[0]!.blob)).w).toBe(800);
  });
  it.each(["zero.jpg", "garbage.png", "truncated.jpg", "huge.png"])("bad input %s fails cleanly, fast", async (n) => {
    const t = performance.now();
    await expect(run(n, { format: "webp" })).rejects.toThrow();
    expect(performance.now() - t).toBeLessThan(20_000);
  });
});

describe("benchmark", () => {
  it("3 x ~3-4MB photos -> WebP q80 in parallel", async () => {
    const files = await Promise.all([1, 2, 3].map((i) => fixture(`photo${i}.jpg`)));
    await engine.run({ toolId: "image-compress", files: [files[0]!], options: { format: "webp", quality: 80 } }); // warm-up not counted separately
    const t = performance.now();
    const rs = await Promise.all(files.map((f) => engine.run({ toolId: "image-compress", files: [f], options: { format: "webp", quality: 80 } })));
    const ms = performance.now() - t;
    console.log(`BENCH warm: 3 photos in ${ms.toFixed(0)} ms; sizes ${files.map((f) => (f.size / 1e6).toFixed(1)).join("/")} MB -> ${rs.map((r) => (r.outputs[0]!.size / 1e6).toFixed(2)).join("/")} MB; cores=${navigator.hardwareConcurrency}`);
    expect(ms).toBeLessThan(8000);
  });
  it("cold start (fresh engine) timing", async () => {
    const e = newEngine(3);
    const files = await Promise.all([1, 2, 3].map((i) => fixture(`photo${i}.jpg`)));
    const t = performance.now();
    await Promise.all(files.map((f) => e.run({ toolId: "image-compress", files: [f], options: { format: "webp", quality: 80 } })));
    console.log(`BENCH cold: 3 photos in ${(performance.now() - t).toFixed(0)} ms`);
    e.dispose();
  });
});

describe("scheduling", () => {
  it("10 simultaneous jobs finish; progress monotonic to 100", async () => {
    const f = await fixture("small.png");
    const seen: number[][] = Array.from({ length: 10 }, () => []);
    const rs = await Promise.all(seen.map((s) => engine.run({ toolId: "image-compress", files: [f], options: { format: "webp" } }, { onProgress: (p) => s.push(p.percent) })));
    expect(rs).toHaveLength(10);
    for (const s of seen) { for (let i = 1; i < s.length; i++) expect(s[i]!).toBeGreaterThanOrEqual(s[i - 1]!); expect(s.at(-1)).toBe(100); }
  });
  it("cancel mid-job rejects with AbortError and frees the slot", async () => {
    const e = newEngine(1);
    const f = await fixture("photo1.jpg");
    const ac = new AbortController();
    const p = e.run({ toolId: "image-compress", files: [f], options: { format: "avif", quality: 60, effort: "best" } }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    const small = await fixture("small.png");
    const r = await e.run({ toolId: "image-compress", files: [small], options: { format: "webp" } });
    expect(r.outputs[0]!.size).toBeGreaterThan(0);
    e.dispose();
  }, 60_000);
});
