import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";

/** Use the default browser if installed, else any preinstalled chromium under the browsers dir. */
function findChromium(): string | undefined {
  try {
    const dirs = fs.readdirSync(browsersPath).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const p = path.join(browsersPath, d, "chrome-linux", "chrome");
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

const PORT = Number(process.env.TEST_PORT ?? 4322);

export default defineConfig({
  testDir: "./test",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    acceptDownloads: true,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: { executablePath: findChromium(), args: ["--enable-unsafe-swiftshader"] },
  },
  webServer: {
    // Test build: mock engine hook enabled, written to dist-test so dist/ stays a production build.
    command: `npm run build && npx astro preview --port ${PORT} --host 127.0.0.1`,
    env: { PUBLIC_TEST_HOOKS: "1", OUT_DIR: "dist-test", SITE_URL: "http://localhost:3000", ASTRO_TELEMETRY_DISABLED: "1" },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
