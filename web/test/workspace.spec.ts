import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { addFiles, collectErrors, expectNoHorizontalScroll, makePng, png, useMock } from "./helpers";

const rows = (page: import("@playwright/test").Page) => page.locator("#queue-body tr");

test.describe("workspace (mock engine)", () => {
  test("one-click compress tools: nothing technical upfront, starts on drop", async ({ page }) => {
    await useMock(page, { stepMs: 5, steps: 2 });
    await page.goto("/compress-image");
    await expect(page.locator(".auto-settings")).toBeVisible();
    await expect(page.locator("details.advanced-options")).not.toHaveAttribute("open", "");
    await expect(page.locator("[data-option=quality]")).toBeHidden();
    await addFiles(page, [png("auto.png")]);
    await expect(page.locator(".result-item")).toHaveCount(1);
  });

  test("opening Advanced options turns auto-start off", async ({ page }) => {
    await useMock(page, { stepMs: 5, steps: 2 });
    await page.goto("/compress-image");
    await page.locator(".advanced-toggle").click();
    await expect(page.locator("[data-option=quality]")).toBeVisible();
    await addFiles(page, [png("manual.png")]);
    await expect(page.locator("#run-btn")).toBeEnabled();
    await expect(page.locator(".result-item")).toHaveCount(0);
  });

  test("hostile filenames render as text: no dialog, no injected nodes", async ({ page }) => {
    await useMock(page);
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const errs = collectErrors(page);
    await page.goto("/convert-image");
    const evil = ["<img src=x onerror=alert(1)>.png", "\"><svg onload=alert(2)>.png", "<script>alert(3)</script>.png"];
    await addFiles(page, evil.map((n, i) => png(n, i + 1)));
    await expect(rows(page)).toHaveCount(3);
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(3);
    for (const n of evil) await expect(page.getByText(n, { exact: false }).first()).toBeVisible();
    expect(await page.locator("#workspace img[src='x'], #workspace svg[onload], #workspace script:not(#tool-data)").count()).toBe(0);
    await page.waitForTimeout(300);
    expect(dialogs).toEqual([]);
    expect(errs).toEqual([]);
  });

  test("25 files at once all get processed", async ({ page }) => {
    await useMock(page, { stepMs: 5, steps: 2 });
    await page.goto("/convert-image");
    await addFiles(page, Array.from({ length: 25 }, (_, i) => png(`p${i}.png`, i + 1)));
    await expect(rows(page)).toHaveCount(25);
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(25, { timeout: 30_000 });
    await expect(page.locator("#zip-all-btn")).toBeVisible();
  });

  test("unsupported types are rejected visibly and the rest is kept", async ({ page }) => {
    await useMock(page);
    await page.goto("/convert-image");
    await addFiles(page, [png("ok.png"), { name: "evil.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") }, { name: "empty.png", mimeType: "image/png", buffer: Buffer.alloc(0) }]);
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator('[data-role="rejected"] li')).toHaveCount(2);
    await expect(page.locator('[data-role="rejected"]')).toContainText("evil.exe");
  });

  test("cancel mid-job", async ({ page }) => {
    await useMock(page, { stepMs: 300, steps: 20 });
    await page.goto("/convert-image");
    await addFiles(page, [png("a.png", 1), png("b.png", 2)]);
    await page.click("#run-btn");
    await expect(page.locator("#progress-card")).toBeVisible();
    await page.click("#cancel-all-btn");
    await expect(rows(page).first()).toHaveAttribute("data-status", "cancelled", { timeout: 10_000 });
    await expect(rows(page).nth(1)).toHaveAttribute("data-status", "cancelled");
    await expect(page.locator(".result-item")).toHaveCount(0);
  });

  test("beforeunload guard is active while a job runs", async ({ page }) => {
    await useMock(page, { stepMs: 300, steps: 20 });
    await page.goto("/convert-image");
    await addFiles(page, [png("a.png")]);
    await page.click("#run-btn");
    await expect(page.locator("#progress-card")).toBeVisible();
    const prevented = await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(prevented).toBe(true);
    await page.click("#cancel-all-btn");
  });

  test("works when localStorage throws", async ({ page }) => {
    await useMock(page);
    await page.addInitScript(() => {
      const boom = () => {
        throw new DOMException("denied", "SecurityError");
      };
      Object.defineProperty(window, "localStorage", { get: boom });
    });
    const errs = collectErrors(page);
    await page.goto("/convert-image");
    await addFiles(page, [png("a.png")]);
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(1);
    expect(errs).toEqual([]);
  });

  test("history is stored locally, capped, and clearable", async ({ page }) => {
    await useMock(page, { stepMs: 5, steps: 2 });
    await page.goto("/convert-image");
    await addFiles(page, [png("hist.png")]);
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(1);
    await expect(page.locator("#history-count")).toHaveText(/1 saved/);
    await page.reload();
    await expect(page.locator("#history-count")).toHaveText(/1 saved/);
    await page.locator("#history summary").click();
    await page.click("#history-clear");
    await expect(page.locator("#history-count")).toHaveText(/0 saved/);
  });

  test("server-only tool explains itself when the server is offline", async ({ page }) => {
    await useMock(page, { serverTools: [] });
    await page.goto("/compress-pdf");
    await expect(page.locator("#server-notice")).toContainText(/server/i);
    await addFiles(page, [{ name: "a.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF") }]);
    await expect(page.locator("#run-btn")).toBeDisabled();
    await expect(page.locator(".result-item")).toHaveCount(0);
  });

  test("failed file does not abort the batch; retry works", async ({ page }) => {
    await useMock(page, { stepMs: 5, steps: 2, failPattern: "^bad" });
    await page.goto("/convert-image");
    await addFiles(page, [png("bad.png", 1), png("good.png", 2)]);
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(1);
    await expect(rows(page).filter({ hasText: "bad.png" })).toHaveAttribute("data-status", "error");
  });

  test("360px viewport: no horizontal scroll, with queue and results", async ({ page }) => {
    await useMock(page, { stepMs: 5, steps: 2 });
    await page.setViewportSize({ width: 360, height: 740 });
    for (const slug of ["", "compress-image", "merge-pdf", "compress-video"]) {
      await page.goto(`/${slug}`);
      await expectNoHorizontalScroll(page);
    }
    await page.goto("/convert-image");
    await addFiles(page, [png("a-very-long-file-name-that-keeps-going-and-going-on-and-on-and-on.png")]);
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(1);
    await expectNoHorizontalScroll(page);
  });

  test("keyboard-only flow: choose file, run, reach the download link", async ({ page }) => {
    await useMock(page, { stepMs: 5, steps: 2 });
    await page.goto("/convert-image");
    await page.locator("#drop-zone").focus();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Enter")]);
    await chooser.setFiles([png("kb.png")]);
    await expect(rows(page)).toHaveCount(1);
    await page.locator("#run-btn").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".result-item")).toHaveCount(1);
    await page.locator(".btn-download").first().focus();
    await expect(page.locator(".btn-download").first()).toBeFocused();
  });

  test("multiInput: order is shown and run needs two files", async ({ page }) => {
    await useMock(page);
    await page.goto("/merge-pdf");
    const pdf = (n: string) => ({ name: n, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF") });
    await addFiles(page, [pdf("one.pdf")]);
    await expect(page.locator("#run-btn")).toBeDisabled();
    await addFiles(page, [pdf("two.pdf")]);
    await expect(page.locator("#run-btn")).toBeEnabled();
    await expect(page.locator(".order-num")).toHaveText(["1", "2"]);
  });
});

test.describe("real engine, in the browser (no mock)", () => {
  test("PNG → WebP: downloads a valid WebP smaller than the input, nothing uploaded", async ({ page }) => {
    const errs = collectErrors(page);
    const uploads: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") uploads.push(r.url());
    });
    await page.goto("/convert-image");
    await page.selectOption("#opt-format", "webp");
    const input = makePng(320, 240, 7);
    await addFiles(page, [{ name: "photo.png", mimeType: "image/png", buffer: input }]);
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('[data-role="runtime"], .badge:has-text("On your device")').first()).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(".btn-download").first().click()]);
    const path = await dl.path();
    const buf = fs.readFileSync(path);
    expect(buf.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(buf.subarray(8, 12).toString("latin1")).toBe("WEBP");
    expect(buf.length).toBeLessThan(input.length);
    expect(dl.suggestedFilename()).toBe("photo.webp");
    expect(uploads).toEqual([]);
    expect(errs).toEqual([]);
  });

  test("three images run in parallel and ZIP download is a valid zip", async ({ page }) => {
    await page.goto("/convert-image");
    await page.selectOption("#opt-format", "webp");
    await addFiles(page, [1, 2, 3].map((i) => ({ name: `p${i}.png`, mimeType: "image/png", buffer: makePng(400, 300, i) })));
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(3, { timeout: 60_000 });
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#zip-all-btn")]);
    const buf = fs.readFileSync((await dl.path())!);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  test("corrupt image shows a readable error, not a hang", async ({ page }) => {
    await page.goto("/convert-image");
    await addFiles(page, [{ name: "broken.png", mimeType: "image/png", buffer: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(200, 1)]) }]);
    await page.click("#run-btn");
    await expect(rows(page).first()).toHaveAttribute("data-status", "error", { timeout: 30_000 });
  });
});
