import { expect, test } from "@playwright/test";
import { tools } from "../../engine/src/tools";
import { useMock } from "./helpers";

test.describe("generic option form", () => {
  for (const tool of tools) {
    test(`${tool.slug}: renders one control per option, defaults applied`, async ({ page }) => {
      await page.goto(`/${tool.slug}`);
      await expect(page.locator("[data-option]")).toHaveCount(tool.options.length);
      for (const f of tool.options) {
        const group = page.locator(`[data-option="${f.key}"]`);
        const visible = !f.showIf || f.showIf.equals.map(String).includes(String(tool.options.find((o) => o.key === f.showIf!.key && "default" in o)?.["default" as never] ?? ""));
        if (visible) await expect(group).toBeVisible();
        else await expect(group).toBeHidden();
        if (f.type === "range") await expect(group.locator('input[type="range"]')).toHaveValue(String(f.default));
        if (f.type === "toggle") await expect(group.locator('input[type="checkbox"]')).toHaveJSProperty("checked", f.default);
        if (f.type === "select" && f.key !== "profile") await expect(group.locator("select")).toHaveValue(f.default);
        if (f.type === "text") await expect(group.locator('input[type="text"]')).toHaveValue(f.default ?? "");
        if (f.type === "number") await expect(group.locator('input[type="number"]')).toHaveValue(f.default === undefined ? "" : String(f.default));
      }
    });
  }

  test("all five field types exist across the registry", () => {
    const types = new Set(tools.flatMap((t) => t.options.map((o) => o.type)));
    expect([...types].sort()).toEqual(["number", "range", "select", "text", "toggle"]);
  });

  test("showIf: video profile=custom reveals advanced fields; pills are radios", async ({ page }) => {
    await page.goto("/compress-video");
    const pills = page.locator(".profile-pill");
    await expect(pills).toHaveCount(4);
    await expect(page.locator('[data-option="crf"]')).toBeHidden();
    await expect(page.locator('[data-option="codec"]')).toBeHidden();
    await page.locator(".profile-pill", { hasText: "Custom" }).click();
    for (const k of ["crf", "codec", "format", "resolution", "audioBitrate"]) await expect(page.locator(`[data-option="${k}"]`)).toBeVisible();
    await page.locator(".profile-pill", { hasText: "Quality-safe" }).click();
    await expect(page.locator('[data-option="crf"]')).toBeHidden();
  });

  test("showIf on select/range/toggle/text: split ranges, video-convert audio toggle, spreadsheet sheets", async ({ page }) => {
    await page.goto("/split-pdf");
    await expect(page.locator('[data-option="ranges"]')).toBeHidden();
    await page.selectOption("#opt-mode", "ranges");
    await expect(page.locator('[data-option="ranges"]')).toBeVisible();
    await page.goto("/convert-video");
    await expect(page.locator('[data-option="stripAudio"]')).toBeVisible();
    await page.selectOption("#opt-format", "gif");
    await expect(page.locator('[data-option="stripAudio"]')).toBeHidden();
    await page.goto("/convert-spreadsheet");
    await expect(page.locator('[data-option="sheets"]')).toBeVisible();
    await page.selectOption("#opt-format", "xlsx");
    await expect(page.locator('[data-option="sheets"]')).toBeHidden();
  });

  test("range output follows slider; invalid number blocks run with a message", async ({ page }) => {
    await useMock(page);
    await page.goto("/compress-image");
    await page.locator("#opt-quality").fill("40");
    await expect(page.locator("#opt-quality-val")).toHaveText("40");
    await page.setInputFiles("#file-input", { name: "a.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]) });
    await page.fill("#opt-width", "0");
    await page.click("#run-btn");
    await expect(page.locator("#notices .notice.error")).toContainText("Max width");
    await expect(page.locator("#opt-width")).toBeFocused();
  });
});
