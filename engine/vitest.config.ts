import { defineConfig } from "vitest/config";

const wasmLibs = ["woff2-encoder", "@ffmpeg/ffmpeg", "@ffmpeg/util", "@ffmpeg/core", "@ffmpeg/core-mt", "@mediabunny/aac-encoder", "@mediabunny/flac-encoder", "@mediabunny/mp3-encoder", "@jsquash/avif", "@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/oxipng", "@jsquash/resize", "mediabunny", "pdfjs-dist", "heic-to", "libimagequant-wasm"];
const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      { test: { name: "unit", environment: "node", include: ["test/unit/**/*.test.ts"] } },
      {
        publicDir: "test/.public",
        server: { headers, fs: { allow: [".."] } },
        optimizeDeps: { exclude: wasmLibs, include: ["exceljs", "pdf-lib"] },
        worker: { format: "es" },
        test: {
          name: "browser",
          include: ["test/browser/**/*.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 60_000,
          browser: {
            enabled: true,
            headless: true,
            provider: "playwright",
            instances: [{ browser: "chromium" }],
            api: { port: 63315, strictPort: false },
          },
        },
      },
    ],
  },
});
