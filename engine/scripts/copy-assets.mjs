#!/usr/bin/env node
// Idempotently copies static assets the engine loads at runtime into <dest>/vendor (default web/public/vendor).
// Usage: node copy-assets.mjs [destPublicDir]
import { cpSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const nm = resolve(here, "../node_modules");
const pub = resolve(process.argv[2] ?? join(here, "../../web/public"));
const vendor = join(pub, "vendor");
const jobs = [
  ["pdfjs-dist/standard_fonts", "pdfjs/standard_fonts"],
  ["pdfjs-dist/cmaps", "pdfjs/cmaps"],
  ["pdfjs-dist/wasm", "pdfjs/wasm"],
  // ffmpeg.wasm single-thread core (≈32 MB, loaded on demand; generated, not committed)
  ["@ffmpeg/core/dist/esm", "ffmpeg/st"],
];
for (const [from, to] of jobs) {
  const src = join(nm, from);
  const dst = join(vendor, to);
  if (!existsSync(src)) { console.warn(`copy-assets: missing ${from}`); continue; }
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true, force: true });
}
console.log(`copy-assets: ${vendor} ${statSync(vendor).isDirectory() ? "ok" : ""}`);
