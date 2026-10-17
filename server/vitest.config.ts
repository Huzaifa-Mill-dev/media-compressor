import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@contracts": fileURLToPath(new URL("./build/contracts", import.meta.url)) },
  },
  test: {
    root: here,
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Real binaries (ffmpeg, soffice, gs) — be generous, but each file keeps its own budget.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Files spin up their own servers on ephemeral ports with isolated temp dirs, but they share the
    // CPU with real encoders; keep parallelism modest so timing-based assertions stay stable.
    fileParallelism: true,
    maxWorkers: 3,
    pool: "forks",
  },
});
