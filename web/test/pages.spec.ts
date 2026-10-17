import { expect, test } from "@playwright/test";
import { tools } from "../../engine/src/tools";
import { collectErrors } from "./helpers";

test.describe("static pages", () => {
  const titles = new Set<string>();
  for (const tool of tools) {
    test(`tool page /${tool.slug}: title, H1, meta, OG, canonical, JSON-LD`, async ({ page }) => {
      const errs = collectErrors(page);
      await page.goto(`/${tool.slug}`);
      const title = await page.title();
      expect(title).toContain(tool.title);
      expect(titles.has(title)).toBe(false);
      titles.add(title);
      await expect(page.locator("h1")).toHaveCount(1);
      expect((await page.locator("h1").innerText()).length).toBeGreaterThan(5);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", tool.description);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `http://localhost:3000/${tool.slug}`);
      for (const p of ["og:title", "og:description", "og:url", "og:type"]) {
        await expect(page.locator(`meta[property="${p}"]`)).toHaveCount(1);
      }
      const ld = await page.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => JSON.parse(e.textContent ?? "null")));
      const app = ld.find((o) => o["@type"] === "WebApplication");
      expect(app?.name).toBeTruthy();
      expect(app?.url).toBe(`http://localhost:3000/${tool.slug}`);
      expect(ld.some((o) => o["@type"] === "FAQPage")).toBe(true);
      await expect(page.locator("#drop-zone")).toBeVisible();
      await expect(page.locator(".faq details").first()).toBeVisible();
      expect(errs).toEqual([]);
    });
  }

  test("home lists every tool and has privacy + speed pitch", async ({ page }) => {
    const errs = collectErrors(page);
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("privately");
    for (const t of tools) await expect(page.locator(`.category-grid a[href="/${t.slug}"]`)).toHaveCount(1);
    await expect(page.getByText("Private by default")).toBeVisible();
    await expect(page.getByText("Fast, in parallel")).toBeVisible();
    expect(errs).toEqual([]);
  });

  test("category pages, privacy, sitemap, robots, 404", async ({ page, request }) => {
    for (const c of ["image", "video", "audio", "font", "pdf", "document", "spreadsheet"]) {
      const r = await page.goto(`/tools/${c}`);
      expect(r?.status()).toBe(200);
      await expect(page.locator("h1")).toBeVisible();
    }
    expect((await page.goto("/privacy"))?.status()).toBe(200);
    const sm = await request.get("/sitemap-0.xml");
    const xml = await sm.text();
    for (const t of tools) expect(xml).toContain(`/${t.slug}</loc>`);
    expect(xml).not.toContain("/404");
    expect(await (await request.get("/robots.txt")).text()).toContain("Sitemap:");
    const nf = await page.goto("/definitely-not-a-page");
    expect(nf?.status()).toBe(404);
    await expect(page.locator("h1")).toHaveText("Page not found");
  });

  test("cross-origin isolation headers present", async ({ page }) => {
    await page.goto("/compress-image");
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  });

  test("no inline event handlers or external hosts in any page", async ({ request }) => {
    for (const t of tools) {
      const html = await (await request.get(`/${t.slug}`)).text();
      expect(html).not.toMatch(/\son[a-z]+="/i);
      expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    }
  });
});
