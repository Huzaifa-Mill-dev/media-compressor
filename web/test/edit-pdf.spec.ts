import { expect, test, type Download, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { collectErrors, expectNoHorizontalScroll, makePng } from "./helpers";

type PdfJs = typeof import("../../engine/node_modules/pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsP: Promise<PdfJs> | null = null;
const pdfjs = () => (pdfjsP ??= import("../../engine/node_modules/pdfjs-dist/legacy/build/pdf.mjs"));

/** Three Letter pages; page 2 has its own /Rotate 90 and a MediaBox that doesn't start at 0,0. */
async function makeFixture(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const p = doc.addPage([612, 792]);
    if (i === 2) {
      p.setMediaBox(50, 50, 612, 792);
      p.setRotation(degrees(90));
    }
    p.drawText(`Original page ${i}`, { x: 100, y: 700, size: 24, font });
  }
  return Buffer.from(await doc.save());
}

/** Hand-written PDF: page 1 has a single (non-array) /Contents stream that leaves the CTM scaled and unbalanced
 *  (no q/Q), page 2 has no /Contents at all. Edits must still land where they were placed. */
function makeRawPdf(): Buffer {
  const content = "2 0 0 2 0 0 cm BT /F1 12 Tf 20 150 Td (Raw original) Tj ET";
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R 6 0 R]/Count 2>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]>>",
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

const pdfFile = async (name = "report.pdf") => ({ name, mimeType: "application/pdf", buffer: await makeFixture() });

async function open(page: Page, name = "report.pdf"): Promise<void> {
  await page.goto("/edit-pdf");
  await expect(page.locator("#pdfed")).toHaveAttribute("data-ready", "1");
  await page.setInputFiles("#pdfed-file", await pdfFile(name));
  await expect(page.locator(".pdfed-page")).toHaveCount(3);
  await expect(page.locator(".pdfed-page").first()).toHaveClass(/rendered/);
}

const pageBox = async (page: Page, i = 0) => (await page.locator(".pdfed-page").nth(i).boundingBox())!;
const tool = (page: Page, name: string): Locator => page.locator("#pdfed-tools").getByRole("button", { name, exact: true });

/** Scroll the editor stage so the fractional page point (fx, fy) is mid-stage; returns the page's new box. */
async function reveal(page: Page, i: number, fx: number, fy: number) {
  await page.evaluate(
    ([i, fx, fy]) => {
      const stage = document.getElementById("pdfed-stage")!;
      window.scrollBy(0, stage.getBoundingClientRect().top - 80); // just below the sticky header
      const el = document.querySelectorAll(".pdfed-page")[i]!;
      const s = stage.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      stage.scrollTop += r.top + fy * r.height - (s.top + s.height / 2);
      stage.scrollLeft += r.left + fx * r.width - (s.left + s.width / 2);
    },
    [i, fx, fy] as const,
  );
  return pageBox(page, i);
}

async function drag(page: Page, i: number, from: [number, number], to: [number, number]): Promise<void> {
  const b = await reveal(page, i, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  await page.mouse.move(b.x + from[0] * b.width, b.y + from[1] * b.height);
  await page.mouse.down();
  await page.mouse.move(b.x + ((from[0] + to[0]) / 2) * b.width, b.y + ((from[1] + to[1]) / 2) * b.height, { steps: 4 });
  await page.mouse.move(b.x + to[0] * b.width, b.y + to[1] * b.height, { steps: 4 });
  await page.mouse.up();
}

async function save(page: Page): Promise<{ dl: Download; bytes: Buffer }> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download PDF" }).click()]);
  return { dl, bytes: fs.readFileSync((await dl.path())!) };
}

async function readPdf(bytes: Buffer) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const p = await doc.getPage(n);
    const vp = p.getViewport({ scale: 1 });
    const text = await p.getTextContent();
    const items = text.items.filter((t): t is (typeof text.items)[number] & { str: string; transform: number[] } => "str" in t && !!t.str);
    const ops = await p.getOperatorList();
    pages.push({
      rotate: p.rotate,
      vp,
      strings: items.map((t) => t.str),
      /** Text origin as a fraction of the displayed page. */
      where: (s: string) => {
        const it = items.find((t) => t.str.includes(s));
        if (!it) return null;
        const [x, y] = vp.convertToViewportPoint(it.transform[4]!, it.transform[5]!);
        return [x! / vp.width, y! / vp.height] as const;
      },
      count: (op: number) => ops.fnArray.filter((f) => f === op).length,
      args: (op: number) => ops.fnArray.flatMap((f, i) => (f === op ? [ops.argsArray[i]] : [])),
    });
  }
  return { lib, pages };
}

test.describe("PDF editor", () => {
  test("open, add text + white-out + image, save: real vector text over the intact original", async ({ page }) => {
    const errs = collectErrors(page);
    await open(page);
    await expect(page.locator(".pdfed-thumb")).toHaveCount(3);

    // White-out across the top of page 1.
    await tool(page, "White-out").click();
    await drag(page, 0, [0.1, 0.08], [0.6, 0.15]);
    await expect(page.locator(".pdfed-ov-whiteout")).toHaveCount(1);

    // Type on top of it.
    await tool(page, "Text").click();
    const b = await reveal(page, 0, 0.15, 0.115);
    await page.mouse.click(b.x + 0.15 * b.width, b.y + 0.115 * b.height);
    await expect(page.locator(".pdfed-text[contenteditable]")).toBeFocused();
    await page.keyboard.type("Hello edited");
    await page.keyboard.press("Escape");
    await expect(page.locator(".pdfed-ov-text")).toHaveText("Hello edited");
    await expect(page.locator(".pdfed-text[contenteditable]")).toHaveCount(0);

    // Insert an image on the current page.
    await page.setInputFiles("#pdfed-image-input", { name: "logo.png", mimeType: "image/png", buffer: makePng(64, 32) });
    await expect(page.locator(".pdfed-ov-image")).toHaveCount(1);
    await expect(page.locator(".pdfed-ov-image img")).toHaveJSProperty("complete", true);

    const { dl, bytes } = await save(page);
    expect(dl.suggestedFilename()).toBe("report-edited.pdf");
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");

    // pdf-lib: structure intact.
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(3);
    expect(out.getPage(1).getRotation().angle).toBe(90);

    // pdf.js: the original text is still there AND the new text is real, extractable text where it was placed.
    const { lib, pages } = await readPdf(bytes);
    const p1 = pages[0]!;
    expect(p1.strings.join(" ")).toContain("Original page 1");
    expect(p1.strings.join(" ")).toContain("Hello edited");
    const at = p1.where("Hello edited")!;
    expect(at[0]).toBeCloseTo(0.15, 1);
    expect(Math.abs(at[1] - 0.115)).toBeLessThan(0.02);
    // White-out is a white vector fill; the image is a real image XObject; nothing was rasterised.
    expect(p1.args(lib.OPS.setFillRGBColor).map(String)).toContain("#ffffff");
    expect(p1.count(lib.OPS.paintImageXObject)).toBe(1);
    expect(pages[1]!.count(lib.OPS.paintImageXObject)).toBe(0);
    expect(pages[1]!.strings.join(" ")).toContain("Original page 2");
    expect(errs).toEqual([]);
  });

  test("overlays on a rotated page with an offset MediaBox land where they were placed", async ({ page }) => {
    await open(page);
    // Rotate page 2 once more in the editor (its own /Rotate is already 90).
    await page.getByRole("button", { name: "Rotate page 2 clockwise" }).click();
    const pg = page.locator(".pdfed-page").nth(1);
    await pg.scrollIntoViewIfNeeded();
    await expect(pg).toHaveClass(/rendered/);
    let box = (await pg.boundingBox())!;
    expect(box.width).toBeLessThan(box.height); // 90 + 90 = 180: portrait again

    await tool(page, "Text").click();
    box = await reveal(page, 1, 0.3, 0.6);
    await page.mouse.click(box.x + 0.3 * box.width, box.y + 0.6 * box.height);
    await page.keyboard.type("Rotated note");
    await page.keyboard.press("Escape");
    await expect(pg.locator(".pdfed-ov-text")).toHaveText("Rotated note");
    await tool(page, "Rectangle").click();
    await drag(page, 1, [0.5, 0.2], [0.8, 0.3]);
    await expect(pg.locator(".pdfed-ov-rect")).toHaveCount(1);

    const { bytes } = await save(page);
    const { lib, pages } = await readPdf(bytes);
    const p2 = pages[1]!;
    expect(p2.rotate).toBe(180);
    const at = p2.where("Rotated note")!;
    expect(Math.abs(at[0] - 0.3)).toBeLessThan(0.03);
    expect(Math.abs(at[1] - 0.6)).toBeLessThan(0.03);
    expect(p2.count(lib.OPS.constructPath)).toBeGreaterThan(0);
  });

  test("shapes, highlight, freehand and signatures are saved as vector paths", async ({ page }) => {
    const errs = collectErrors(page);
    await open(page);
    const shapes: [string, string, [number, number], [number, number]][] = [
      ["Rectangle", "rect", [0.1, 0.3], [0.3, 0.4]],
      ["Ellipse", "ellipse", [0.4, 0.3], [0.6, 0.4]],
      ["Line", "line", [0.1, 0.5], [0.4, 0.55]],
      ["Arrow", "arrow", [0.5, 0.5], [0.8, 0.6]],
      ["Highlight", "highlight", [0.1, 0.65], [0.5, 0.68]],
    ];
    for (const [name, kind, a, z] of shapes) {
      await tool(page, name).click();
      await drag(page, 0, a, z);
      await expect(page.locator(`.pdfed-ov-${kind}`)).toHaveCount(1);
    }
    await tool(page, "Draw").click();
    await drag(page, 0, [0.2, 0.8], [0.5, 0.85]);
    await expect(page.locator(".pdfed-ov-ink")).toHaveCount(1);

    // Drawn signature.
    await page.getByRole("button", { name: "Sign" }).click();
    const pad = page.locator("#pdfed-sign-pad");
    const pb = (await pad.boundingBox())!;
    await page.mouse.move(pb.x + 40, pb.y + 120);
    await page.mouse.down();
    await page.mouse.move(pb.x + 120, pb.y + 50, { steps: 5 });
    await page.mouse.move(pb.x + 200, pb.y + 130, { steps: 5 });
    await page.mouse.up();
    await page.getByRole("button", { name: "Insert signature" }).click();
    await expect(page.locator(".pdfed-ov-ink")).toHaveCount(2);

    // Typed signature.
    await page.getByRole("button", { name: "Sign" }).click();
    await page.getByRole("tab", { name: "Type" }).click();
    await page.getByLabel("Your name").fill("Ada Lovelace");
    await page.getByRole("button", { name: "Insert signature" }).click();
    await expect(page.locator(".pdfed-ov-text")).toHaveText("Ada Lovelace");

    // Undo / redo round-trip.
    await expect(page.locator(".pdfed-ov")).toHaveCount(8);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".pdfed-ov")).toHaveCount(7);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.locator(".pdfed-ov")).toHaveCount(8);

    const { bytes } = await save(page);
    const { lib, pages } = await readPdf(bytes);
    const p1 = pages[0]!;
    expect(p1.strings.join(" ")).toContain("Ada Lovelace");
    // rect, ellipse, line, arrow shaft + head, highlight, ink ×2 → at least 8 paths; no images.
    expect(p1.count(lib.OPS.constructPath)).toBeGreaterThanOrEqual(8);
    expect(p1.count(lib.OPS.paintImageXObject)).toBe(0);
    expect(p1.count(lib.OPS.setGState)).toBeGreaterThanOrEqual(1); // highlight opacity/multiply
    expect(errs).toEqual([]);
  });

  test("select, move, resize, restyle and delete an overlay", async ({ page }) => {
    await open(page);
    await tool(page, "Rectangle").click();
    await drag(page, 0, [0.2, 0.2], [0.4, 0.3]);
    const rect = page.locator(".pdfed-ov-rect");
    const before = (await rect.boundingBox())!;
    // Move by dragging the body.
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 40, { steps: 5 });
    await page.mouse.up();
    const moved = (await rect.boundingBox())!;
    expect(moved.x - before.x).toBeCloseTo(60, -1);
    expect(moved.y - before.y).toBeCloseTo(40, -1);
    // Resize from the south-east handle.
    const se = page.locator('.pdfed-h[data-h="se"]');
    const hb = (await se.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 50, hb.y + 30, { steps: 5 });
    await page.mouse.up();
    const resized = (await rect.boundingBox())!;
    expect(resized.width - moved.width).toBeGreaterThan(30);
    // Restyle: fill it.
    await page.getByLabel("Filled").check();
    await expect(rect).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    // Delete.
    await page.getByRole("button", { name: "Delete selected item" }).click();
    await expect(rect).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(rect).toHaveCount(1);
  });

  test("page list: rotate, reorder, delete, with undo", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Delete page 1" }).click();
    await expect(page.locator(".pdfed-page")).toHaveCount(2);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator(".pdfed-page")).toHaveCount(3);
    await page.getByRole("button", { name: "Move page 3 up" }).click();
    await expect(page.getByRole("button", { name: "Move page 2 up" })).toBeFocused();
    await page.getByRole("button", { name: "Rotate page 1 clockwise" }).click();
    await page.getByRole("button", { name: "Delete page 3" }).click();
    await expect(page.locator(".pdfed-thumb")).toHaveCount(2);

    await page.locator(".pdfed-thumb").first().evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 150));
    // Drag the second thumbnail above the first.
    await page.locator(".pdfed-thumb").nth(1).dragTo(page.locator(".pdfed-thumb").nth(0), { targetPosition: { x: 20, y: 5 } });

    const { bytes } = await save(page);
    const { pages } = await readPdf(bytes);
    expect(pages.map((p) => p.strings.join(" "))).toEqual(["Original page 3", "Original page 1"]);
    expect(pages[1]!.rotate).toBe(90);
  });

  test("keyboard: tools insert on the current page, arrows move, Enter edits, Delete removes", async ({ page }) => {
    await open(page);
    // Toolbar is a roving-tabindex toolbar.
    await tool(page, "Select").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tool(page, "Text")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".pdfed-text[contenteditable]")).toBeFocused();
    await page.keyboard.type("Typed by keyboard");
    await page.keyboard.press("Escape");
    const text = page.locator(".pdfed-ov-text");
    await expect(text).toBeFocused();
    const x0 = (await text.boundingBox())!.x;
    await page.keyboard.press("Shift+ArrowRight");
    expect((await text.boundingBox())!.x).toBeGreaterThan(x0 + 3);
    await page.keyboard.press("Enter");
    await page.keyboard.type(" again");
    await page.keyboard.press("Escape");
    await expect(text).toHaveText("Typed by keyboard again");
    await page.keyboard.press("Delete");
    await expect(text).toHaveCount(0);

    await tool(page, "Rectangle").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".pdfed-ov-rect")).toBeFocused();
  });

  test("works at phone width without horizontal scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await open(page);
    await expectNoHorizontalScroll(page);
    const b = await pageBox(page, 0);
    expect(b.width).toBeLessThanOrEqual(375);
    await expect(tool(page, "Text")).toBeVisible();
    await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible();
  });

  test("hand-written PDFs: single content stream with an unbalanced CTM, and a page without content", async ({ page }) => {
    await page.goto("/edit-pdf");
    await page.setInputFiles("#pdfed-file", { name: "raw.pdf", mimeType: "application/pdf", buffer: makeRawPdf() });
    await expect(page.locator(".pdfed-page")).toHaveCount(2);
    await expect(page.locator(".pdfed-page").first()).toHaveClass(/rendered/);
    for (const i of [0, 1]) {
      await tool(page, "Text").click();
      const b = await reveal(page, i, 0.25, 0.5);
      await page.mouse.click(b.x + 0.25 * b.width, b.y + 0.5 * b.height);
      await page.keyboard.type(`Note ${i + 1}`);
      await page.keyboard.press("Escape");
      await expect(page.locator(".pdfed-page").nth(i).locator(".pdfed-ov-text")).toHaveText(`Note ${i + 1}`);
    }
    const { bytes } = await save(page);
    const { pages } = await readPdf(bytes);
    expect(pages[0]!.strings.join(" ")).toContain("Raw original");
    for (const i of [0, 1]) {
      const at = pages[i]!.where(`Note ${i + 1}`)!;
      expect(Math.abs(at[0] - 0.25)).toBeLessThan(0.02);
      expect(Math.abs(at[1] - 0.5)).toBeLessThan(0.03);
    }
  });

  test("rejects files that aren't PDFs", async ({ page }) => {
    await page.goto("/edit-pdf");
    await page.setInputFiles("#pdfed-file", { name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("hello") });
    await expect(page.locator("#pdfed-notices .notice.error")).toContainText("isn't a PDF");
    await expect(page.locator("#pdfed-app")).toBeHidden();
  });

  test("linked from the home and PDF category pages, listed in the sitemap", async ({ page, request }) => {
    await page.goto("/");
    await expect(page.locator('.category-grid a[href="/edit-pdf"]')).toHaveCount(1);
    await page.goto("/tools/pdf");
    await expect(page.locator('.category-grid a[href="/edit-pdf"]')).toHaveCount(1);
    expect(await (await request.get("/sitemap-0.xml")).text()).toContain("/edit-pdf</loc>");
    const html = await (await request.get("/edit-pdf")).text();
    expect(html).not.toMatch(/\son[a-z]+="/i);
    await page.goto("/edit-pdf");
    await expect(page.locator("h1")).toHaveText("Edit PDF");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "http://localhost:3000/edit-pdf");
  });
});
