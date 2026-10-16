#!/usr/bin/env node
// Generates test fixtures into test/fixtures (idempotent; skips existing). Pure Node: no system binaries.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../test/fixtures");
mkdirSync(dir, { recursive: true });
const f = (n) => join(dir, n);
const require = createRequire(import.meta.url);
// sharp lives in the repo root install; pdf-lib/exceljs/pdfjs-dist are engine deps
const sharp = require(require.resolve("sharp", { paths: [here, join(here, "../..")] }));
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const ExcelJS = require("exceljs");

const jobs = [];
const make = (n, fn) => { if (!existsSync(f(n))) jobs.push((async () => { try { await fn(f(n)); } catch (e) { console.warn("fixture skipped:", n, e.message); } })()); };

// deterministic PRNG so fixtures are stable
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

function noisyGradient(w, h, seed, amp) {
  const r = rng(seed), buf = Buffer.alloc(w * h * 3);
  let p = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = (r() + r() - 1) * amp;
    buf[p++] = clamp(16 + (x / w) * 224 + n);
    buf[p++] = clamp(160 - (y / h) * 120 + n);
    buf[p++] = clamp(240 - (x / w) * 200 + (y / h) * 60 + n);
  }
  return buf;
}
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const raw = (w, h, ch) => ({ raw: { width: w, height: h, channels: ch } });

// 4000x3000 noisy gradient photos (~3 MB JPEG each)
for (const i of [1, 2, 3]) make(`photo${i}.jpg`, (o) => sharp(noisyGradient(4000, 3000, i, 16), raw(4000, 3000, 3)).jpeg({ quality: 92 }).toFile(o));
make("small.png", (o) => sharp(noisyGradient(800, 600, 9, 90), raw(800, 600, 3)).png().toFile(o));
make("flat.png", (o) => sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#fff"/><circle cx="300" cy="200" r="140" fill="#2a6"/><rect x="20" y="20" width="180" height="100" fill="#c33"/></svg>')).png().toFile(o));
make("alpha.png", (o) => sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><circle cx="150" cy="100" r="80" fill="rgba(255,0,0,0.6)"/></svg>')).png().toFile(o));
make("opt.jpg", (o) => sharp(noisyGradient(300, 200, 4, 10), raw(300, 200, 3)).jpeg({ quality: 20 }).toFile(o));
// EXIF orientation 6 (needs rotating 90° CW): stored 400x200, displays 200x400
make("rotated.jpg", (o) => sharp(noisyGradient(400, 200, 5, 10), raw(400, 200, 3)).withMetadata({ orientation: 6 }).jpeg({ quality: 85 }).toFile(o));
make("truncated.jpg", async (o) => { const b = await sharp(noisyGradient(800, 600, 6, 90), raw(800, 600, 3)).jpeg({ quality: 90 }).toBuffer(); writeFileSync(o, b.subarray(0, 6000)); });
make("zero.jpg", (o) => writeFileSync(o, ""));
make("garbage.png", (o) => writeFileSync(o, Buffer.from("this is not a png at all, just text".repeat(20))));
// PNG header claiming 40000x40000 (valid CRC) → must be rejected before decoding
make("huge.png", (o) => {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(40000, 0); ihdr.writeUInt32BE(40000, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(o, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(10))), chunk("IEND", Buffer.alloc(0))]));
});

async function pdf(o, labels, bg) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (const t of labels) {
    const p = d.addPage([300, 400]);
    p.drawRectangle({ x: 0, y: 0, width: 300, height: 400, color: bg });
    p.drawText(t, { x: 20, y: 330, size: 40, font, color: rgb(0, 0, 0) });
  }
  writeFileSync(o, await d.save());
}
make("a.pdf", (o) => pdf(o, ["A1", "A2", "A3"], rgb(1, 1, 1)));
make("b.pdf", (o) => pdf(o, ["B1"], rgb(0.68, 0.85, 0.9)));
make("sheet.csv", (o) => writeFileSync(o, '﻿name,note,qty\r\n"Smith, J","said ""hi""\nsecond line",3\r\nÉlodie,ünï,007\r\n'));
// Liberation Sans ships inside pdfjs-dist (no OS font dependency)
make("font.ttf", (o) => copyFileSync(require.resolve("pdfjs-dist/package.json").replace("package.json", "standard_fonts/LiberationSans-Regular.ttf"), o));
make("book.xlsx", async (o) => {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet("Sheet1"); s.addRow(["a", "b"]); s.addRow([1, "x, y"]);
  wb.addWorksheet("S2").addRow(["z", 2]);
  await wb.xlsx.writeFile(o);
});

await Promise.all(jobs);
console.log("fixtures ready:", dir);
// Serve fixtures to the browser project (vitest publicDir = test/.public)
import { cpSync } from "node:fs";
cpSync(dir, join(here, "../test/.public/fixtures"), { recursive: true });
