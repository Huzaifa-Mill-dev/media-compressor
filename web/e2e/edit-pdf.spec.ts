import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";

/** The PDF editor under the real server's headers: strict CSP (no inline script, no eval) + COOP/COEP. */
test("PDF editor loads pdf.js, renders, edits and saves with no CSP violations", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 300]).drawText("Server-served original", { x: 40, y: 240, size: 18, font });
  const input = Buffer.from(await doc.save());

  const res = await page.goto("/edit-pdf");
  expect(res?.status()).toBe(200);
  expect(res?.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  await page.setInputFiles("#pdfed-file", { name: "served.pdf", mimeType: "application/pdf", buffer: input });
  await expect(page.locator(".pdfed-page.rendered")).toHaveCount(1);
  await expect(page.locator(".pdfed-thumb canvas")).toHaveCount(1);

  await page.locator('#pdfed-tools [data-tool="text"]').focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Added under CSP");
  await page.keyboard.press("Escape");

  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download PDF" }).click()]);
  expect(dl.suggestedFilename()).toBe("served-edited.pdf");
  const out = await PDFDocument.load(fs.readFileSync((await dl.path())!));
  expect(out.getPageCount()).toBe(1);

  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(errs.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});
