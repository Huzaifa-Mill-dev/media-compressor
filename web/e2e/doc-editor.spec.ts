import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import mammoth from "mammoth";

/**
 * /edit-document against the real Express server: its strict CSP (no inline scripts, no eval) and COOP/COEP must
 * let every editor chunk load, and PDF export must use LibreOffice when the server has it.
 */
const SAMPLE = path.join(import.meta.dirname, "..", "test", "fixtures", "sample.docx");

test("document editor loads under the production CSP, imports, saves DOCX and exports PDF", async ({ page, request }) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource.*\/api\/stats/.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()}`));

  const res = await page.goto("/edit-document");
  expect(res?.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.locator("#doc-app")).toHaveAttribute("data-state", "ready");

  await page.setInputFiles("#doc-file-input", SAMPLE);
  await expect(page.locator("#doc-message")).toHaveText("Opened sample.docx.");
  const c = page.locator("#doc-editor .doc-content");
  await expect(c.locator("h1")).toHaveText("Quarterly Report");
  await expect(c.locator("th")).toHaveText(["Region", "Revenue"]);

  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#doc-save-docx")]);
  const { value: html } = await mammoth.convertToHtml({ buffer: fs.readFileSync((await dl.path())!) });
  expect(html).toContain("<h1>Quarterly Report</h1>");
  expect(html).toMatch(/<table>[\s\S]*North[\s\S]*<\/table>/);

  const tools = ((await (await request.get("/api/capabilities")).json()) as { tools: string[] }).tools;
  if (tools.includes("document-convert")) {
    const [pdf] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.click("#doc-save-pdf")]);
    expect(pdf.suggestedFilename()).toBe("sample.pdf");
    expect(fs.readFileSync((await pdf.path())!).subarray(0, 5).toString()).toBe("%PDF-");
  } else {
    await page.evaluate(() => (window.print = () => void ((window as unknown as { __printed: number }).__printed = 1)));
    await page.click("#doc-save-pdf");
    await expect(page.locator("#doc-message")).toContainText("Save as PDF");
    expect(await page.evaluate(() => (window as unknown as { __printed?: number }).__printed)).toBe(1);
  }
  expect(problems).toEqual([]);
});
