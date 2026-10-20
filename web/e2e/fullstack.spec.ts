import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

const rows = (page: Page) => page.locator("#queue-body tr");
const add = (page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) => page.setInputFiles("#file-input", files);
const txt = (name: string, body = "Hello from the E2E suite\nSecond line\n") => ({ name, mimeType: "text/plain", buffer: Buffer.from(body) });

/** Minimal but fully valid PDF (correct xref offsets) that Ghostscript and qpdf both accept. */
function makePdf(): Buffer {
  const content = "BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET";
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const MIN_PDF = makePdf();
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

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
    await expect(page.locator(".result-item .runtime-server")).toBeVisible();
    const buf = await download(page);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("PDF → Word via the UI returns an editable DOCX", async ({ page }) => {
    needs("pdf-to-docx");
    await page.goto("/pdf-to-word");
    await add(page, [{ name: "letter.pdf", mimeType: "application/pdf", buffer: MIN_PDF }]);
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(1, { timeout: 120_000 });
    await expect(page.locator(".result-item .runtime-server")).toBeVisible();
    const buf = await download(page);
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    expect(buf.includes(Buffer.from("word/document.xml"))).toBe(true);
  });

  test("PDF compression via the UI never returns a larger file", async ({ page }) => {
    needs("pdf-compress");
    await page.goto("/compress-pdf");
    await add(page, [{ name: "tiny.pdf", mimeType: "application/pdf", buffer: MIN_PDF }]);
    await page.click("#run-btn");
    await expect(rows(page).first()).toHaveAttribute("data-status", /done|error/, { timeout: 120_000 });
    expect(await rows(page).first().innerText()).not.toMatch(/Failed/);
    await expect(page.locator(".result-item")).toHaveCount(1);
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
    await add(page, [{ name: "fake.pdf", mimeType: "application/pdf", buffer: PNG_1PX }]);
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
    await add(page, [{ name: "px.png", mimeType: "image/png", buffer: PNG_1PX }]);
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(1, { timeout: 60_000 });
  });

  test("stats endpoint is aggregate-only and the page never leaks file names", async ({ page, request }) => {
    const s = await (await request.get("/api/stats")).json();
    expect(Object.keys(s).sort()).toEqual(["totalJobs", "totalSavedBytes"]);
    await page.goto("/");
    expect(await page.content()).not.toMatch(/note\.txt|doc1\.txt/);
  });
});
