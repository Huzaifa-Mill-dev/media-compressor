import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import { collectErrors, expectNoHorizontalScroll } from "./helpers";

/** Hand-written Word-style DOCX (see fixtures/make-sample-docx.mjs). */
const SAMPLE = path.join(import.meta.dirname, "fixtures", "sample.docx");
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const content = (page: Page) => page.locator("#doc-editor .doc-content");

/** Put the caret at the end of an element, or select all its text (Home/End differ between macOS and Linux). */
async function placeCaret(loc: Locator, mode: "end" | "select" = "end"): Promise<void> {
  await loc.click();
  await loc.evaluate((el, m) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    if (m === "end") r.collapse(false);
    const s = getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  }, mode);
  await loc.page().waitForTimeout(50); // ProseMirror syncs on selectionchange
}

async function openEditor(page: Page, opts: { serverTools?: string[] } = {}): Promise<void> {
  // No real server in this suite: answer /api/capabilities so behaviour doesn't depend on whatever runs on :3000.
  await page.route("**/api/capabilities", (r) => r.fulfill({ json: { tools: opts.serverTools ?? [], limits: {} } }));
  await page.goto("/edit-document");
  await expect(page.locator("#doc-app")).toHaveAttribute("data-state", "ready");
}

async function importSample(page: Page): Promise<void> {
  await page.setInputFiles("#doc-file-input", SAMPLE);
  await expect(page.locator("#doc-message")).toHaveText("Opened sample.docx.");
}

async function saveDocx(page: Page): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#doc-save-docx")]);
  expect(dl.suggestedFilename()).toMatch(/\.docx$/);
  return fs.readFileSync((await dl.path())!);
}

test.describe("Document editor", () => {
  test("page shell: title, H1, breadcrumbs, JSON-LD, linked from home and Document category", async ({ page }) => {
    const errors = collectErrors(page);
    await openEditor(page);
    await expect(page).toHaveTitle(/Word Editor/);
    await expect(page.locator("h1")).toHaveText("Edit document");
    const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(ld.map((b) => JSON.parse(b)["@type"])).toEqual(["WebApplication", "BreadcrumbList", "FAQPage"]);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await page.goto("/");
    await expect(page.locator('a[href="/edit-document"]')).toHaveCount(1);
    await page.goto("/tools/document");
    await expect(page.locator('a[href="/edit-document"]')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("imports a DOCX keeping headings, formatting, lists, tables, links, images and page breaks", async ({ page }) => {
    const errors = collectErrors(page);
    await openEditor(page);
    await importSample(page);
    const c = content(page);
    await expect(c.locator("h1")).toHaveText("Quarterly Report");
    await expect(c.locator("h2")).toHaveText(["Overview", "Appendix"]);
    await expect(c.locator("strong", { hasText: "bold" })).toHaveCount(1);
    await expect(c.locator("em", { hasText: "italic" })).toHaveCount(1);
    await expect(c.locator("u", { hasText: "underlined" })).toHaveCount(1);
    await expect(c.locator("p", { hasText: "Centred line" })).toHaveCSS("text-align", "center");
    await expect(c.locator("p", { hasText: "Indented paragraph" })).toHaveAttribute("data-indent", "2");
    await expect(c.locator("span", { hasText: "Big text" })).toHaveAttribute("style", /font-size:\s*16pt/);
    await expect(c.locator("mark", { hasText: "highlighted text" })).toHaveCount(1);
    await expect(c.locator("ul > li")).toHaveText(["First bullet", "Second bullet"]);
    await expect(c.locator("ol > li")).toHaveText(["Step one", "Step two"]);
    await expect(c.locator("th")).toHaveText(["Region", "Revenue"]);
    await expect(c.locator("td")).toHaveText(["North", "120", "South", "95"]);
    await expect(c.locator('a[href="https://example.com/"]')).toHaveText("our website");
    await expect(c.locator('img[src^="data:image/png"]')).toHaveAttribute("alt", "Red square");
    await expect(c.locator(".page-break")).toHaveCount(1);
    await expect(page.locator("#doc-name")).toHaveValue("sample");
    await expect(page.locator("#doc-count")).toContainText("words");
    expect(errors).toEqual([]);
  });

  test("edit with the toolbar, export DOCX, and the DOCX round-trips", async ({ page }) => {
    await openEditor(page);
    await importSample(page);
    const c = content(page);

    // Type at the end of the document, then add a heading with the paragraph-style menu.
    await placeCaret(c.locator("p", { hasText: "The end." }));
    await page.keyboard.type(" Edited by test.");
    await page.keyboard.press("Enter");
    await page.selectOption("#tb-style", "h2");
    await page.keyboard.type("Added section");
    await page.keyboard.press("Enter");
    await page.click('[data-cmd="bold"]');
    await page.keyboard.type("Bold words");
    await expect(c.locator("h2", { hasText: "Added section" })).toHaveCount(1);
    await expect(c.locator("strong", { hasText: "Bold words" })).toHaveCount(1);

    // Table: add a row below "South" from the contextual table toolbar.
    await c.locator("td", { hasText: "South" }).click();
    await expect(page.locator("#doc-tablebar")).toBeVisible();
    await page.click('[data-cmd="row-after"]');
    await expect(c.locator("tr")).toHaveCount(4);
    await c.locator("tr").nth(3).locator("td").first().click();
    await page.keyboard.type("East");
    await page.keyboard.press("Tab");
    await page.keyboard.type("77");
    await expect(c.locator("tr")).toHaveCount(4);

    const buf = await saveDocx(page);
    expect(buf.subarray(0, 2).toString()).toBe("PK");

    // Re-read with mammoth in Node: an independent DOCX reader.
    const { value: html } = await mammoth.convertToHtml({ buffer: buf });
    expect(html).toContain("<h1>Quarterly Report</h1>");
    expect(html).toContain("<h2>Added section</h2>");
    expect(html).toContain("Edited by test.");
    expect(html).toMatch(/<strong>Bold words<\/strong>/);
    expect(html).toMatch(/<table>[\s\S]*Region[\s\S]*North[\s\S]*East[\s\S]*77[\s\S]*<\/table>/);
    expect(html).toMatch(/<ul><li>First bullet<\/li><li>Second bullet<\/li><\/ul>/);
    expect(html).toMatch(/<ol><li>Step one<\/li><li>Step two<\/li><\/ol>/);
    expect(html).toContain('<a href="https://example.com/">our website</a>');
    expect(html).toMatch(/<img [^>]*src="data:image\/png/);

    // …and back into the editor.
    page.once("dialog", (d) => void d.accept());
    await page.setInputFiles("#doc-file-input", { name: "roundtrip.docx", mimeType: DOCX_MIME, buffer: buf });
    await expect(page.locator("#doc-message")).toHaveText("Opened roundtrip.docx.");
    await expect(c.locator("h1")).toHaveText("Quarterly Report");
    await expect(c.locator("h2")).toHaveText(["Overview", "Appendix", "Added section"]);
    await expect(c.locator("td")).toHaveText(["North", "120", "South", "95", "East", "77"]);
    await expect(c.locator("p", { hasText: "Centred line" })).toHaveCSS("text-align", "center");
    await expect(c.locator("p", { hasText: "Indented paragraph" })).toHaveAttribute("data-indent", "2");
    await expect(c.locator("mark", { hasText: "highlighted text" })).toHaveCount(1);
    await expect(c.locator(".page-break")).toHaveCount(1);
  });

  test("a blank document: lists, alignment, links, tables and page breaks export", async ({ page }) => {
    await openEditor(page);
    const c = content(page);
    await c.click();
    await page.selectOption("#tb-style", "h1");
    await page.keyboard.type("Fresh title");
    await page.keyboard.press("Enter");
    await page.click('[data-cmd="align-center"]');
    await page.keyboard.type("Centred");
    await page.keyboard.press("Enter");
    await page.click('[data-cmd="align-left"]');
    await page.click('[data-cmd="numbers"]');
    await page.keyboard.type("One");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Two");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Example");
    await placeCaret(c.locator("p", { hasText: "Example" }), "select");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.locator("#doc-link-dialog")).toBeVisible();
    await page.fill("#doc-link-url", "example.org");
    await page.keyboard.press("Enter");
    await expect(c.locator('a[href="https://example.org"]')).toHaveText("Example");
    await placeCaret(c.locator("p", { hasText: "Example" }));
    await page.click('[data-cmd="page-break"]');
    await page.click('[data-cmd="table"]');
    await page.fill("#doc-table-rows", "2");
    await page.fill("#doc-table-cols", "2");
    await page.click('#doc-table-form button[type="submit"]');
    await expect(c.locator("table tr")).toHaveCount(2);
    await page.keyboard.type("A1");

    const buf = await saveDocx(page);
    const { value: html } = await mammoth.convertToHtml({ buffer: buf });
    expect(html).toContain("<h1>Fresh title</h1>");
    expect(html).toMatch(/<ol><li>One<\/li><li>Two<\/li><\/ol>/);
    expect(html).toContain('<a href="https://example.org">Example</a>');
    expect(html).toMatch(/<table>[\s\S]*A1[\s\S]*<\/table>/);
  });

  test("find & replace", async ({ page }) => {
    await openEditor(page);
    const c = content(page);
    await c.click();
    await page.keyboard.type("The cat sat. A Cat ran. cat!");
    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.locator("#doc-find")).toBeVisible();
    await page.fill("#find-q", "cat");
    await expect(page.locator("#find-count")).toHaveText("1 of 3");
    await expect(c.locator(".find-hit")).toHaveCount(3);
    await page.check("#find-case");
    await expect(page.locator("#find-count")).toHaveText("1 of 2");
    await page.locator("#find-q").press("Enter");
    await expect(page.locator("#find-count")).toHaveText("2 of 2");
    await page.fill("#find-r", "dog");
    await page.click("#find-replace-all");
    await expect(c).toHaveText("The dog sat. A Cat ran. dog!");
    await page.locator("#find-q").press("Escape");
    await expect(page.locator("#doc-find")).toBeHidden();
    await expect(c.locator(".find-hit")).toHaveCount(0);
  });

  test("autosaves a draft and offers to restore or discard it", async ({ page }) => {
    await openEditor(page);
    await content(page).click();
    await page.keyboard.type("Remember me");
    await page.fill("#doc-name", "My notes");
    await expect(page.locator("#doc-draft")).toContainText("Draft saved");

    await page.reload();
    await expect(page.locator("#doc-app")).toHaveAttribute("data-state", "ready");
    await expect(page.locator("#doc-restore")).toBeVisible();
    await expect(page.locator("#doc-restore-text")).toContainText("My notes");
    await page.click("#doc-restore-yes");
    await expect(content(page)).toHaveText("Remember me");
    await expect(page.locator("#doc-name")).toHaveValue("My notes");

    await page.reload();
    await page.click("#doc-restore-no");
    await expect(page.locator("#doc-restore")).toBeHidden();
    await page.reload();
    await expect(page.locator("#doc-app")).toHaveAttribute("data-state", "ready");
    await expect(page.locator("#doc-restore")).toBeHidden();
  });

  test("works when localStorage throws", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("blocked", "SecurityError");
        },
      });
    });
    const errors = collectErrors(page);
    await openEditor(page);
    await content(page).click();
    await page.keyboard.type("No storage");
    await expect(page.locator("#doc-draft")).toContainText("Couldn't autosave");
    expect(errors).toEqual([]);
  });

  test("Export PDF falls back to the print dialog when the server can't convert", async ({ page }) => {
    await page.addInitScript(() => {
      window.print = () => void ((window as unknown as { __printed: number }).__printed = 1);
    });
    await openEditor(page, { serverTools: [] });
    await content(page).click();
    await page.keyboard.type("Print me");
    await page.click("#doc-save-pdf");
    await expect(page.locator("#doc-message")).toContainText("Save as PDF");
    expect(await page.evaluate(() => (window as unknown as { __printed?: number }).__printed)).toBe(1);
  });

  test("Export PDF converts the DOCX on the server when document-convert is offered", async ({ page }) => {
    let uploaded = "";
    await openEditor(page, { serverTools: ["document-convert"] });
    await page.route("**/api/jobs", async (r) => {
      uploaded = r.request().postDataBuffer()?.toString("latin1") ?? "";
      await r.fulfill({ status: 202, json: { jobId: "job1" } });
    });
    const done = { id: "job1", status: "done", percent: 100, outputs: [{ name: "doc.pdf", size: 8, mime: "application/pdf", url: "/api/jobs/job1/files/0" }] };
    await page.route("**/api/jobs/job1/events", (r) => r.fulfill({ headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify(done)}\n\n` }));
    await page.route("**/api/jobs/job1", (r) => r.fulfill({ json: done }));
    await page.route("**/api/jobs/job1/files/0", (r) => r.fulfill({ body: "%PDF-1.4", headers: { "content-type": "application/pdf" } }));
    await content(page).click();
    await page.keyboard.type("Server PDF");
    await page.fill("#doc-name", "Report");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#doc-save-pdf")]);
    expect(dl.suggestedFilename()).toBe("Report.pdf");
    expect(uploaded).toContain('name="tool"\r\n\r\ndocument-convert');
    expect(uploaded).toContain('"format":"pdf"');
    expect(uploaded).toContain('filename="Report.docx"');
  });

  test("opening a PDF without the pdf-to-docx server tool explains what to do", async ({ page }) => {
    await openEditor(page);
    await page.setInputFiles("#doc-file-input", { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
    await expect(page.locator("#doc-message")).toHaveAttribute("data-kind", "error");
    await expect(page.locator("#doc-message")).toContainText("PDF");
  });

  test("toolbar is a single tab stop with arrow-key navigation; Esc returns to the page", async ({ page }) => {
    await openEditor(page);
    await content(page).click();
    await page.keyboard.press("Alt+F10");
    await expect(page.locator("#tb-style")).toBeFocused(); // undo/redo are disabled in a fresh document
    const first = await page.evaluate(() => document.activeElement?.getAttribute("data-cmd") ?? document.activeElement?.id);
    await page.keyboard.press("ArrowRight");
    const second = await page.evaluate(() => document.activeElement?.getAttribute("data-cmd") ?? document.activeElement?.id);
    expect(second).not.toBe(first);
    expect(await page.locator("#doc-toolbar [tabindex='0']").count()).toBe(1);
    await page.keyboard.press("Escape");
    await expect(content(page)).toBeFocused();
    // Ctrl+B from the keyboard
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.type("Strong");
    await expect(content(page).locator("strong")).toHaveText("Strong");
    await expect(page.locator('[data-cmd="bold"]')).toHaveAttribute("aria-pressed", "true");
  });

  test("phone width: no horizontal page scroll and the editor is usable", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await openEditor(page);
    await importSample(page);
    await expectNoHorizontalScroll(page);
    await placeCaret(content(page).locator("h1"));
    await page.keyboard.type(" 2026");
    await expect(content(page).locator("h1")).toHaveText("Quarterly Report 2026");
  });
});
