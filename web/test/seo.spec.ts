import { expect, test } from "@playwright/test";
import { tools } from "../../engine/src/tools";

/** Cross-page SEO invariants (per-page title/H1/meta/JSON-LD are covered in pages.spec.ts). */
test.describe("SEO invariants", () => {
  let sitemapUrls: string[] = [];
  test.beforeAll(async ({ request }) => {
    const idx = await (await request.get("/sitemap-index.xml")).text();
    const maps = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(maps.length).toBeGreaterThan(0);
    for (const m of maps) {
      const body = await (await request.get(new URL(m).pathname)).text();
      sitemapUrls.push(...[...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => x[1]!));
    }
  });

  test("sitemap lists every tool page exactly once, with absolute URLs", () => {
    for (const t of tools) expect(sitemapUrls.filter((u) => new URL(u).pathname.replace(/\/$/, "") === `/${t.slug}`), t.slug).toHaveLength(1);
    expect(new Set(sitemapUrls).size).toBe(sitemapUrls.length);
    for (const u of sitemapUrls) expect(() => new URL(u)).not.toThrow();
  });

  test("every sitemap URL resolves 200 and is canonical to itself", async ({ page }) => {
    for (const u of sitemapUrls) {
      const path = new URL(u).pathname;
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      const canon = await page.locator('link[rel="canonical"]').getAttribute("href");
      expect(new URL(canon!).pathname.replace(/\/$/, ""), path).toBe(path.replace(/\/$/, ""));
      await expect(page.locator("html")).toHaveAttribute("lang", /^en/);
      await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
    }
  });

  test("titles and descriptions are unique; one H1 per page; images have alt text", async ({ page }) => {
    const titles = new Set<string>();
    const descs = new Set<string>();
    for (const t of tools) {
      await page.goto(`/${t.slug}`);
      const title = await page.title();
      const desc = (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
      expect(title.length, t.slug).toBeLessThanOrEqual(70);
      expect(desc.length, t.slug).toBeGreaterThan(50);
      expect(desc.length, t.slug).toBeLessThanOrEqual(200);
      expect(titles.has(title), `dup title ${t.slug}`).toBe(false);
      expect(descs.has(desc), `dup description ${t.slug}`).toBe(false);
      titles.add(title);
      descs.add(desc);
      await expect(page.locator("h1")).toHaveCount(1);
      expect(await page.locator("img:not([alt])").count(), `${t.slug} images without alt`).toBe(0);
    }
  });

  test("tool pages ship parseable JSON-LD with a FAQ block", async ({ page }) => {
    for (const t of tools) {
      await page.goto(`/${t.slug}`);
      const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
      expect(blocks.length, t.slug).toBeGreaterThan(0);
      const types = blocks.flatMap((b) => {
        const j = JSON.parse(b);
        return (Array.isArray(j) ? j : j["@graph"] ?? [j]).map((n: { "@type": string }) => n["@type"]);
      });
      expect(types.join(","), t.slug).toMatch(/FAQPage/);
    }
  });

  test("robots.txt points at the sitemap and does not block the site", async ({ request }) => {
    const r = await (await request.get("/robots.txt")).text();
    expect(r).toMatch(/Sitemap:\s*https?:\/\//i);
    expect(r).not.toMatch(/Disallow:\s*\/\s*$/m);
  });
});
