// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

const SITE_URL = process.env.SITE_URL || "http://localhost:3000";
const API_TARGET = process.env.API_TARGET || "http://localhost:3000";

/** Cross-origin isolation (SharedArrayBuffer → multithreaded WASM) + basic hardening. */
const securityHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const apiProxy = {
  "/api": { target: API_TARGET, changeOrigin: true },
};

// WASM / worker-heavy libraries must not be pre-bundled by esbuild/rolldown in dev,
// otherwise their `new URL("x.wasm", import.meta.url)` lookups break.
const wasmLibs = [
  "@jsquash/avif",
  "@jsquash/jpeg",
  "@jsquash/png",
  "@jsquash/webp",
  "@jsquash/oxipng",
  "@jsquash/resize",
  "@ffmpeg/ffmpeg",
  "@ffmpeg/util",
  "@ffmpeg/core",
  "@ffmpeg/core-mt",
  "wawoff2",
  "mediabunny",
  "@mediabunny/aac-encoder",
  "@mediabunny/flac-encoder",
  "@mediabunny/mp3-encoder",
  "pdfjs-dist",
  "heic-to",
  "libheif-js",
  "libimagequant-wasm",
];

export default defineConfig({
  site: SITE_URL,
  output: "static",
  outDir: "./dist",
  trailingSlash: "never",
  build: {
    format: "file",
    // CSP: no inline <style>/<script> — always emit external files.
    inlineStylesheets: "never",
  },
  devToolbar: { enabled: false },
  integrations: [
    sitemap({
      filter: (page) => !/\/404\/?$/.test(page),
    }),
  ],
  server: { port: 4321, headers: securityHeaders },
  vite: {
    server: {
      fs: { allow: [".."] },
      headers: securityHeaders,
      proxy: apiProxy,
    },
    preview: {
      headers: securityHeaders,
      proxy: apiProxy,
    },
    build: {
      // Never inline scripts/assets into HTML (CSP script-src 'self').
      assetsInlineLimit: 0,
    },
    worker: { format: "es" },
    optimizeDeps: { exclude: wasmLibs },
  },
});
