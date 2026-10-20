import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

/**
 * Full-stack E2E: the REAL Express server serving the REAL production build (web/dist), no mock engine.
 * Prerequisite: `npm run build` at the repo root. Server tools whose binaries are missing locally are skipped
 * (the specs read /api/capabilities); CI has every binary installed.
 */
const PORT = 4399;
const tmp = path.join(os.tmpdir(), `mt-e2e-${process.pid}`);

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, acceptDownloads: true, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: {
    command: "node ../server/dist/index.js",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      HOST: "127.0.0.1",
      LOG_LEVEL: "error",
      JOBS_DIR: path.join(tmp, "jobs"),
      DATA_DIR: path.join(tmp, "data"),
      WEB_DIST: path.resolve("dist"),
      RATE_LIMIT_MAX: "1000",
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      PYTHON: process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    },
  },
});
