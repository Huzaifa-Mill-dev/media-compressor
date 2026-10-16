#!/usr/bin/env node
// Generates test fixtures into test/fixtures (idempotent; skips existing).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures");
mkdirSync(dir, { recursive: true });
const f = (n) => join(dir, n);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "ignore" });
const make = (n, fn) => { if (!existsSync(f(n))) { try { fn(f(n)); } catch (e) { console.warn("fixture skipped:", n, e.message); } } };

// 4000x3000 noisy gradient photos (~3 MB JPEG each)
for (const i of [1, 2, 3]) {
  make(`photo${i}.jpg`, (o) => run("convert", ["-size", "4000x3000", `gradient:#${i}0a0f0-#f0${i}0a0`, "-attenuate", "0.35", "+noise", "Gaussian", "-blur", "0x0.6", "-quality", "92", o]));
}
make("small.png", (o) => run("convert", ["-size", "800x600", "plasma:fractal", o]));
make("flat.png", (o) => run("convert", ["-size", "600x400", "xc:white", "-fill", "#2a6", "-draw", "circle 300,200 300,60", "-fill", "#c33", "-draw", "rectangle 20,20 200,120", o]));
make("alpha.png", (o) => run("convert", ["-size", "300x200", "xc:none", "-fill", "rgba(255,0,0,0.6)", "-draw", "circle 150,100 150,20", o]));
make("opt.jpg", (o) => run("convert", ["-size", "300x200", "gradient:blue-white", "-quality", "20", o]));
// EXIF orientation 6 (needs rotating 90° CW): stored 400x200, displays 200x400
make("rotated.jpg", (o) => run("convert", ["-size", "400x200", "gradient:red-yellow", "-orient", "undefined", "-set", "exif:Orientation", "6", "-define", "jpeg:preserve-settings", o]));
make("truncated.jpg", (o) => { run("convert", ["-size", "800x600", "plasma:fractal", f("_t.jpg")]); const b = execFileSync("head", ["-c", "6000", f("_t.jpg")]); writeFileSync(o, b); });
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
// PDFs (3 pages each via ImageMagick/gs)
make("a.pdf", (o) => run("convert", ["-size", "300x400", "xc:white", "-pointsize", "40", "-annotate", "+20+60", "A1", "(", "-clone", "0", "-annotate", "+20+120", "A2", ")", "(", "-clone", "0", "-annotate", "+20+180", "A3", ")", "-delete", "0", o]));
make("b.pdf", (o) => run("convert", ["-size", "300x400", "xc:lightblue", "-pointsize", "40", "-annotate", "+20+60", "B1", o]));
make("sheet.csv", (o) => writeFileSync(o, '﻿name,note,qty\r\n"Smith, J","said ""hi""\nsecond line",3\r\nÉlodie,ünï,007\r\n'));
make("font.ttf", (o) => run("cp", ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", o]));
make("font.otf", (o) => run("sh", ["-c", `cp "$(ls /usr/share/fonts/opentype/inter/Inter-Regular.otf)" "${o}"`]));
make("book.xlsx", (o) => run("python3", ["-I", "-c", "import sys;from openpyxl import Workbook;w=Workbook();s=w.active;s.append(['a','b']);s.append([1,'x, y']);w.create_sheet('S2').append(['z',2]);w.save(sys.argv[1])", o]));
console.log("fixtures ready:", dir);
