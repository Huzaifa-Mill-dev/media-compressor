import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

const rows = (page: Page) => page.locator("#queue-body tr");
const add = (page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) => page.setInputFiles("#file-input", files);
const txt = (name: string, body = "Hello from the E2E suite\nSecond line\n") => ({ name, mimeType: "text/plain", buffer: Buffer.from(body) });
/** Smallest PDF that Ghostscript and qpdf both accept. */
const MIN_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n",
);

let serverTools: string[] = [];
test.beforeAll(async ({ request }) => {
  serverTools = ((await (await request.get("/api/capabilities")).json()) as { tools: string[] }).tools;
});
const needs = (tool: string) => test.skip(!serverTools.includes(tool), `server has no binaries for ${tool} here`);

async function download(page: Page, selector = ".btn-download"): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(selector).first().click()]);
  return fs.readFileSync((await dl.path())!);
}

test.describe("real server + built site", () => {
  test("served with isolation headers and the engine boots (cross-origin isolated)", async ({ page }) => {
    await page.goto("/compress-image");
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    const r = await page.request.get("/compress-image");
    expect(r.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
  });

  test("document → PDF via the UI runs on our server", async ({ page }) => {
    needs("document-convert");
    await page.goto("/convert-document");
    await add(page, [txt("note.txt")]);
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByText("On our server").first()).toBeVisible();
    const buf = await download(page);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("PDF compression via the UI never returns a larger file", async ({ page }) => {
    needs("pdf-compress");
    await page.goto("/compress-pdf");
    await add(page, [{ name: "tiny.pdf", mimeType: "application/pdf", buffer: MIN_PDF }]);
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(1, { timeout: 120_000 });
    const buf = await download(page);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeLessThanOrEqual(MIN_PDF.length);
  });

  test("several heavy jobs at once queue up and all finish", async ({ page }) => {
    needs("document-convert");
    await page.goto("/convert-document");
    await add(page, [1, 2, 3, 4].map((i) => txt(`doc${i}.txt`, `Document ${i}\n`)));
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(4, { timeout: 240_000 });
    for (let i = 0; i < 4; i++) await expect(rows(page).nth(i)).toHaveAttribute("data-status", "done");
  });

  test("cancel a server job from the UI", async ({ page }) => {
    needs("document-convert");
    await page.goto("/convert-document");
    await add(page, [txt("a.txt"), txt("b.txt")]);
    await page.click("#run-btn");
    await expect(page.locator("#progress-card")).toBeVisible();
    await page.click("#cancel-all-btn");
    for (let i = 0; i < 2; i++) await expect(rows(page).nth(i)).toHaveAttribute("data-status", /cancelled|done/, { timeout: 30_000 });
    // the server must still be healthy and idle afterwards
    expect((await (await page.request.get("/api/health")).json()).ok).toBe(true);
  });

  test("damaged PDF shows a readable error banner, the page stays usable", async ({ page }) => {
    needs("pdf-compress");
    await page.goto("/compress-pdf");
    await add(page, [{ name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nthis is not really a pdf\n") }]);
    await page.click("#run-btn");
    await expect(rows(page).first()).toHaveAttribute("data-status", "error", { timeout: 60_000 });
    await expect(rows(page).first()).toContainText(/pdf/i);
    await expect(page.locator("#run-btn")).toBeVisible();
  });

  test("wrong content for the extension is refused (PNG named .pdf)", async ({ page }) => {
    needs("pdf-compress");
    await page.goto("/compress-pdf");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    await add(page, [{ name: "fake.pdf", mimeType: "application/pdf", buffer: png }]);
    await page.click("#run-btn");
    await expect(rows(page).first()).toHaveAttribute("data-status", "error", { timeout: 30_000 });
  });

  test("server down: the tool page explains it and nothing crashes", async ({ page }) => {
    const errs: string[] = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.route("**/api/**", (r) => r.abort());
    await page.goto("/compress-pdf");
    await expect(page.locator("#server-notice")).toContainText(/unavailable|server/i);
    await expect(page.locator("#run-btn")).toBeDisabled();
    expect(errs).toEqual([]);
  });

  test("browser-run tools keep working with the server down", async ({ page }) => {
    await page.route("**/api/**", (r) => r.abort());
    await page.goto("/convert-image");
    await page.selectOption("#opt-format", "webp");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    await add(page, [{ name: "px.png", mimeType: "image/png", buffer: png }]);
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(1, { timeout: 60_000 });
  });

  test("stats endpoint is aggregate-only and the badge/API never leak file names", async ({ page, request }) => {
    const s = await (await request.get("/api/stats")).json();
    expect(Object.keys(s).sort()).toEqual(["totalJobs", "totalSavedBytes"]);
    await page.goto("/");
    expect(await page.content()).not.toMatch(/note\.txt|doc1\.txt/);
  });
});
