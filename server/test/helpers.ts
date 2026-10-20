import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import request from "supertest";
import { createApp, type App } from "../src/app.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { probeBinaries, type Binaries } from "../src/probe.js";
import { setPrlimit } from "../src/proc.js";

export interface Harness {
  app: App;
  http: ReturnType<typeof request>;
  cfg: ServerConfig;
  bins: Binaries;
  dir: string;
  cleanup(): Promise<void>;
}

const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
let binsPromise: Promise<Binaries> | null = null;
export const getBins = () => (binsPromise ??= probeBinaries(PY, { allowUnisolatedOffice: process.env.ALLOW_UNISOLATED_OFFICE === "1" }).then((b) => (setPrlimit(b.prlimit), b)));

export async function start(overrides: Partial<ServerConfig> = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-test-"));
  const bins = await getBins();
  const cfg = loadConfig({}, { logLevel: "silent", dataDir: path.join(dir, "data"), jobsDir: path.join(dir, "jobs"), webDist: path.join(dir, "no-web"), python: PY, ...overrides });
  const app = await createApp(cfg, bins);
  return {
    app,
    http: request(app.app),
    cfg,
    bins,
    dir,
    async cleanup() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const TERMINAL = ["done", "error", "cancelled"];
export interface UpFile {
  data: Buffer | string;
  name: string;
}

/** Upload and return the raw response. */
export function upload(h: Harness, tool: string, files: UpFile[], options: unknown = {}) {
  let r = h.http.post("/api/jobs").field("tool", tool).field("options", typeof options === "string" ? options : JSON.stringify(options));
  for (const f of files) r = r.attach("files", Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data), { filename: f.name });
  return r;
}

export async function waitJob(h: Harness, id: string, timeoutMs = 60_000): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const j = (await h.http.get(`/api/jobs/${id}`)).body;
    if (TERMINAL.includes(j.status)) return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} still ${j.status} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Upload, expect 202, wait for completion. */
export async function runJob(h: Harness, tool: string, files: UpFile[], options: unknown = {}, timeoutMs = 60_000) {
  const r = await upload(h, tool, files, options);
  if (r.status !== 202) throw new Error(`upload failed ${r.status}: ${JSON.stringify(r.body)}`);
  return waitJob(h, r.body.jobId, timeoutMs);
}

export async function download(h: Harness, job: any, index = 0): Promise<{ body: Buffer; headers: Record<string, string> }> {
  const r = await h.http
    .get(job.outputs[index].url)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  if (r.status !== 200) throw new Error(`download ${r.status}`);
  return { body: r.body as Buffer, headers: r.headers as Record<string, string> };
}

// ---- fixtures (generated in-process; no external files) ------------------------------------------
export const png = (w = 64, h = 48, color = "#22aa66") => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
export const jpg = (w = 64, h = 48) => sharp({ create: { width: w, height: h, channels: 3, background: "#cc3333" } }).jpeg().toBuffer();
export async function noisyJpg(w = 1600, h = 1200): Promise<Buffer> {
  const b = Buffer.alloc(w * h * 3);
  let s = 12345;
  for (let i = 0; i < b.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    b[i] = (s >> 16) & 255;
  }
  return sharp(b, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}
export async function pdf(pages = 3): Promise<Buffer> {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([300, 400]).drawText(`Page ${i + 1}`, { x: 30, y: 300, size: 30 });
  return Buffer.from(await d.save());
}
/** Header-only PNG that claims 40000x40000 pixels (valid CRCs): a pixel/decompression bomb. */
export function pixelBomb(): Buffer {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(40000, 0);
  ihdr.writeUInt32BE(40000, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.alloc(10)), chunk("IEND", Buffer.alloc(0))]);
}
