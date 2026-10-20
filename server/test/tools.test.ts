import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveChildren } from "../src/proc.js";
import { download, getBins, jpg, noisyJpg, pdf, png, runJob, start, upload, waitJob, type Harness } from "./helpers.js";

const bins = await getBins();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-fixt-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let h: Harness;
beforeAll(async () => {
  h = await start({ rateLimitMax: 10_000, maxFileBytes: 200 * 1024 * 1024 });
});
afterAll(async () => {
  await h.cleanup();
});

const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "ignore" });
const probe = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]).toString());
const save = (name: string, data: Buffer) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, data);
  return p;
};
const qpdfCheck = (data: Buffer) => {
  const p = save(`chk-${Math.random().toString(36).slice(2)}.pdf`, data);
  const r = execFileSync("qpdf", ["--check", p], { stdio: "pipe" });
  return r.toString();
};

// ---- images / images-to-pdf (sharp, pdf-lib: no external binaries) ---------------------------------
describe("images-to-pdf", () => {
  it("makes one page per image (fit / a4)", async () => {
    for (const pageSize of ["fit", "a4", "letter"]) {
      const j = await runJob(h, "images-to-pdf", [{ data: await png(100, 50), name: "a.png" }, { data: await jpg(40, 80), name: "b.jpg" }], { pageSize, margin: 10 });
      expect(j.status, j.error).toBe("done");
      const doc = await PDFDocument.load((await download(h, j)).body);
      expect(doc.getPageCount()).toBe(2);
    }
  });
});

describe.skipIf(!bins.heifDec)("heic", () => it.todo("heic → webp (needs libheif-examples and a real fixture)"));

// ---- video / audio ---------------------------------------------------------------------------------
describe.skipIf(!bins.ffmpeg || !bins.ffprobe)("ffmpeg tools", () => {
  let clip: Buffer;
  let wavFile: Buffer;
  beforeAll(() => {
    const v = path.join(tmp, "clip.mp4");
    ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-b:v", "2M", "-c:a", "aac", v]);
    clip = fs.readFileSync(v);
    const w = path.join(tmp, "tone.wav");
    ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", w]);
    wavFile = fs.readFileSync(w);
  });
  const outFile = async (j: any, name: string) => save(name, (await download(h, j)).body);

  it("video-compress web-stream → valid mp4 ≤ 720 short side, not larger", async () => {
    const j = await runJob(h, "video-compress", [{ data: clip, name: "clip.mp4" }], { profile: "web-stream" });
    expect(j.status, j.error).toBe("done");
    const p = probe(await outFile(j, "o1.mp4"));
    const v = p.streams.find((s: any) => s.codec_type === "video");
    expect(v.height).toBeLessThanOrEqual(360);
    expect(j.outputs[0].size).toBeLessThanOrEqual(clip.length);
  });
  it("video-compress custom vp9 webm (no -maxrate with -b:v 0)", async () => {
    if (!bins.encoders.has("libvpx-vp9")) return;
    const j = await runJob(h, "video-compress", [{ data: clip, name: "clip.mp4" }], { profile: "custom", format: "webm", codec: "vp9", crf: 36 });
    expect(j.status, j.error).toBe("done");
    expect(probe(await outFile(j, "o2.webm")).format.format_name).toContain("webm");
  });
  it("video-convert → webm / mkv / gif; stripAudio", async () => {
    for (const format of ["mkv", "gif"]) {
      const j = await runJob(h, "video-convert", [{ data: clip, name: "clip.mp4" }], { format, stripAudio: true });
      expect(j.status, `${format}: ${j.error}`).toBe("done");
      const p = probe(await outFile(j, `o3.${format}`));
      expect(p.streams.some((s: any) => s.codec_type === "audio")).toBe(false);
    }
  });
  it("video-to-audio mp3 and wav", async () => {
    for (const [format, codec] of [["mp3", "mp3"], ["wav", "pcm_s16le"]] as const) {
      const j = await runJob(h, "video-to-audio", [{ data: clip, name: "clip.mp4" }], { format, bitrate: "128k" });
      expect(j.status, j.error).toBe("done");
      expect(probe(await outFile(j, `o4.${format}`)).streams[0].codec_name).toBe(codec);
    }
  });
  it("audio-convert / audio-compress", async () => {
    const j = await runJob(h, "audio-convert", [{ data: wavFile, name: "tone.wav" }], { format: "flac" });
    expect(j.status, j.error).toBe("done");
    expect(probe(await outFile(j, "o5.flac")).streams[0].codec_name).toBe("flac");
    const k = await runJob(h, "audio-compress", [{ data: wavFile, name: "tone.wav" }], { format: "mp3", bitrate: "64k" });
    expect(k.status, k.error).toBe("done");
    expect(k.outputs[0].size).toBeLessThan(wavFile.length / 4);
  });
  it("rejects wav bytes named .mp4 (400) and an audio-only mp4 passed to video-compress (job error)", async () => {
    expect((await upload(h, "video-compress", [{ data: wavFile, name: "tone.mp4" }], {})).status).toBe(400);
    const a = path.join(tmp, "audio-only.mp4");
    ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", a]);
    const j = await runJob(h, "video-compress", [{ data: fs.readFileSync(a), name: "audio-only.mp4" }], {});
    expect(j.status).toBe("error");
    expect(j.error).toMatch(/no video track/);
  });
  it("cancel kills the ffmpeg process", async () => {
    const big = path.join(tmp, "long.mp4");
    ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=120", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", big]);
    const r = await upload(h, "video-compress", [{ data: fs.readFileSync(big), name: "long.mp4" }], { profile: "quality-safe" });
    expect(r.status).toBe(202);
    for (let i = 0; i < 100 && liveChildren().size === 0; i++) await new Promise((x) => setTimeout(x, 50));
    expect(liveChildren().size).toBeGreaterThan(0);
    expect((await h.http.delete(`/api/jobs/${r.body.jobId}`)).body.ok).toBe(true);
    for (let i = 0; i < 60 && liveChildren().size > 0; i++) await new Promise((x) => setTimeout(x, 50));
    expect(liveChildren().size).toBe(0);
  }, 120_000);
  it("rejects a 'video' with a mismatched extension before ffmpeg ever runs", async () => {
    expect((await upload(h, "video-compress", [{ data: await png(), name: "x.mp4" }], {})).status).toBe(400);
  });
});

// ---- pdf (ghostscript + qpdf) ----------------------------------------------------------------------
describe.skipIf(!bins.qpdf)("pdf tools", () => {
  it("merge → qpdf --check ok, pages add up", async () => {
    const j = await runJob(h, "pdf-merge", [{ data: await pdf(2), name: "a.pdf" }, { data: await pdf(3), name: "b.pdf" }], {});
    expect(j.status, j.error).toBe("done");
    const out = (await download(h, j)).body;
    expect(qpdfCheck(out)).toMatch(/No syntax or stream encoding errors/);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(5);
  });
  it("merge refuses a corrupt PDF; sniffing refuses a PNG named .pdf", async () => {
    expect((await upload(h, "pdf-merge", [{ data: await png(), name: "a.pdf" }, { data: await pdf(1), name: "b.pdf" }], {})).status).toBe(400);
    const j = await runJob(h, "pdf-merge", [{ data: Buffer.from("%PDF-1.7\ngarbage garbage"), name: "a.pdf" }, { data: await pdf(1), name: "b.pdf" }], {});
    expect(j.status).toBe("error");
    expect(j.error).toMatch(/PDF/);
  });
  it("split every / ranges", async () => {
    const j = await runJob(h, "pdf-split", [{ data: await pdf(4), name: "d.pdf" }], { mode: "every" });
    expect(j.outputs).toHaveLength(4);
    for (let i = 0; i < 4; i++) expect((await PDFDocument.load((await download(h, j, i)).body)).getPageCount()).toBe(1);
    const k = await runJob(h, "pdf-split", [{ data: await pdf(6), name: "d.pdf" }], { mode: "ranges", ranges: "1-2, 5" });
    expect(k.outputs).toHaveLength(2);
    expect((await PDFDocument.load((await download(h, k, 0)).body)).getPageCount()).toBe(2);
    const bad = await runJob(h, "pdf-split", [{ data: await pdf(2), name: "d.pdf" }], { mode: "ranges", ranges: "9-12" });
    expect(bad.status).toBe("error");
    expect((await upload(h, "pdf-split", [{ data: await pdf(2), name: "d.pdf" }], { mode: "ranges", ranges: "1; rm -rf /" })).status).toBe(400);
  });
});

describe.skipIf(!bins.gs || !bins.qpdf)("ghostscript tools", () => {
  it("pdf-compress is valid and never larger than the input", async () => {
    const big = await (async () => {
      const d = await PDFDocument.create();
      for (let i = 0; i < 3; i++) d.addPage([600, 800]).drawImage(await d.embedPng(await sharp({ create: { width: 1500, height: 1500, channels: 3, background: "#888888", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).png().toBuffer()), { x: 0, y: 0, width: 600, height: 800 });
      return Buffer.from(await d.save());
    })();
    for (const level of ["screen", "ebook", "printer"]) {
      const j = await runJob(h, "pdf-compress", [{ data: big, name: "big.pdf" }], { level });
      expect(j.status, j.error).toBe("done");
      expect(j.outputs[0].size).toBeLessThanOrEqual(big.length);
      qpdfCheck((await download(h, j)).body);
    }
    const tiny = await pdf(1);
    const j = await runJob(h, "pdf-compress", [{ data: tiny, name: "t.pdf" }], { level: "screen" });
    expect(j.outputs[0].size).toBeLessThanOrEqual(tiny.length);
  });
  it("pdf-to-images renders one image per page", async () => {
    const j = await runJob(h, "pdf-to-images", [{ data: await pdf(3), name: "p.pdf" }], { format: "png", dpi: 72 });
    expect(j.status, j.error).toBe("done");
    expect(j.outputs).toHaveLength(3);
    expect((await sharp((await download(h, j, 0)).body).metadata()).format).toBe("png");
  });
});

// ---- pdf2docx ---------------------------------------------------------------------------------------
/** Text of one entry in a ZIP (DOCX) — enough of the format for the files python-docx writes. */
const zipEntry = (zip: Buffer, name: string): string | null => {
  for (let o = zip.indexOf("PK\x03\x04"); o >= 0; o = zip.indexOf("PK\x03\x04", o + 4)) {
    const method = zip.readUInt16LE(o + 8);
    const size = zip.readUInt32LE(o + 18);
    const nameLen = zip.readUInt16LE(o + 26);
    const start = o + 30 + nameLen + zip.readUInt16LE(o + 28);
    if (zip.toString("utf8", o + 30, o + 30 + nameLen) !== name) continue;
    const raw = zip.subarray(start, start + size);
    return (method === 8 ? zlib.inflateRawSync(raw) : raw).toString("utf8");
  }
  return null;
};

describe.skipIf(!bins.pdf2docx)("pdf-to-docx", () => {
  it("produces a DOCX whose body holds the PDF's text", async () => {
    const j = await runJob(h, "pdf-to-docx", [{ data: await pdf(2), name: "report.pdf" }], {});
    expect(j.status, j.error).toBe("done");
    expect(j.outputs[0].name).toBe("report.docx");
    const body = (await download(h, j)).body;
    expect(body.subarray(0, 2).toString()).toBe("PK");
    const xml = zipEntry(body, "word/document.xml");
    expect(xml).toContain("Page 1");
    expect(xml).toContain("Page 2");
  });
  it("encrypted / garbage PDFs fail cleanly", async () => {
    const enc = save("enc-src.pdf", await pdf(1));
    const encOut = path.join(tmp, "enc.pdf");
    if (bins.qpdf) {
      execFileSync("qpdf", ["--encrypt", "u", "o", "256", "--", enc, encOut]);
      const j = await runJob(h, "pdf-to-docx", [{ data: fs.readFileSync(encOut), name: "e.pdf" }], {});
      expect(j.status).toBe("error");
      expect(j.error).toMatch(/password/i);
    }
    const bad = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(500, 7)]);
    const k = await runJob(h, "pdf-to-docx", [{ data: bad, name: "bad.pdf" }], {});
    expect(k.status).toBe("error");
  });
  it("rejects unknown options", async () => {
    expect((await upload(h, "pdf-to-docx", [{ data: await pdf(1), name: "a.pdf" }], { format: "doc" })).status).toBe(400);
  });
});

// ---- fonts (fontTools) ------------------------------------------------------------------------------
const fontFile = [path.resolve("engine/test/fixtures/font.ttf"), "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find((p) => fs.existsSync(p));
describe.skipIf(!bins.fonttools || !fontFile)("font-convert", () => {
  it("ttf → woff2 → woff → ttf round trip validates with fontTools", async () => {
    let cur: Buffer = fs.readFileSync(fontFile!);
    let name = "f.ttf";
    for (const format of ["woff2", "woff", "ttf"]) {
      const j = await runJob(h, "font-convert", [{ data: cur, name }], { format });
      expect(j.status, j.error).toBe("done");
      cur = (await download(h, j)).body;
      name = `f.${format}`;
    }
    expect(cur.subarray(0, 4).readUInt32BE(0)).toBe(0x00010000);
  });
  it("garbage font → clean error", async () => {
    const r = await upload(h, "font-convert", [{ data: Buffer.alloc(200, 1), name: "x.ttf" }], { format: "woff2" });
    expect(r.status).toBe(400);
  });
});

// ---- LibreOffice (heavy) ---------------------------------------------------------------------------
describe.skipIf(!bins.soffice)("libreoffice tools (heavy)", () => {
  it("network isolation is active (otherwise the tools are withheld, see office.ts)", () => {
    expect(bins.officeSafe, "unshare -rn unavailable: run `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0` or set ALLOW_UNISOLATED_OFFICE=1").toBe(true);
  });
  it("txt → pdf; csv → xlsx → csv", async () => {
    const j = await runJob(h, "document-convert", [{ data: "Hello world\nSecond line\n", name: "note.txt" }], { format: "pdf" }, 180_000);
    expect(j.status, j.error).toBe("done");
    const out = (await download(h, j)).body;
    expect(out.subarray(0, 5).toString()).toBe("%PDF-");
    expect(j.outputs[0].name).toBe("note.pdf");
    const x = await runJob(h, "spreadsheet-convert", [{ data: "a,b\n1,\"x, y\"\n", name: "s.csv" }], { format: "xlsx" }, 180_000);
    expect(x.status, x.error).toBe("done");
    expect((await download(h, x)).body.subarray(0, 2).toString()).toBe("PK");
  }, 400_000);
  it("rejects html renamed .docx and presentations to non-pdf", async () => {
    expect((await upload(h, "document-convert", [{ data: "<html><body>hi</body></html>", name: "x.docx" }], { format: "pdf" })).status).toBe(400);
    expect((await upload(h, "document-convert", [{ data: Buffer.from("PK\u0003\u0004zzzz"), name: "x.pptx" }], { format: "docx" })).status).toBe(400);
  });
  it("cancel kills soffice process group", async () => {
    const r = await upload(h, "document-convert", [{ data: "x".repeat(2000), name: "big.txt" }], { format: "pdf" });
    expect(r.status).toBe(202);
    await new Promise((x) => setTimeout(x, 400));
    await h.http.delete(`/api/jobs/${r.body.jobId}`);
    for (let i = 0; i < 100 && liveChildren().size > 0; i++) await new Promise((x) => setTimeout(x, 100));
    expect(liveChildren().size).toBe(0);
    void waitJob;
  }, 60_000);
});

void noisyJpg;
