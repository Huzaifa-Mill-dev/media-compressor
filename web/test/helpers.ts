import { expect, type Page } from "@playwright/test";
import zlib from "node:zlib";

/** Deterministic, valid RGB PNG with a gradient + noise so it actually compresses. */
export function makePng(w = 96, h = 96, seed = 1): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let s = seed;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 255) / w + (s & 7);
      raw[o + 1] = (y * 255) / h + ((s >> 3) & 7);
      raw[o + 2] = 128 + ((s >> 6) & 15);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export interface MockCfg {
  stepMs?: number;
  steps?: number;
  failPattern?: string;
  serverTools?: string[];
  outputs?: number;
  qualityScore?: number;
  runtime?: "browser" | "server";
}

export async function useMock(page: Page, cfg: MockCfg = {}): Promise<void> {
  await page.addInitScript((c) => {
    (window as unknown as { __MT_MOCK__: unknown }).__MT_MOCK__ = c;
  }, cfg);
}

/** Console errors, ignoring the expected failed /api/stats fetch when no server runs. */
export function collectErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/Failed to load resource/.test(m.text())) return;
    errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  return errs;
}

export const png = (name: string, seed = 1) => ({ name, mimeType: "image/png", buffer: makePng(48, 48, seed) });

export async function addFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  await page.setInputFiles("#file-input", files);
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
}
