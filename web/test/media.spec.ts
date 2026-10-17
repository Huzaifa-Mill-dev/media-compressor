import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { addFiles, collectErrors } from "./helpers";

/** Record ~1.2 s of animated canvas with MediaRecorder (WebM) inside the page: no ffmpeg needed to make a fixture. */
async function recordClip(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 240;
    const ctx = c.getContext("2d")!;
    const stream = c.captureStream(15);
    const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm" });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.start(100);
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = `hsl(${i * 20},80%,50%)`;
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = "#fff";
      ctx.fillRect(10 + i * 14, 90, 60, 60);
      await new Promise((r) => setTimeout(r, 70));
    }
    rec.stop();
    await done;
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  return Buffer.from(bytes);
}

test.describe("in-browser video/audio (real engine, cross-origin isolated)", () => {
  test("video compress runs on the device and downloads a valid file", async ({ page }) => {
    const errs = collectErrors(page);
    const posts: string[] = [];
    page.on("request", (r) => r.method() === "POST" && posts.push(r.url()));
    await page.goto("/compress-video");
    const clip = await recordClip(page);
    expect(clip.length).toBeGreaterThan(1000);
    await addFiles(page, [{ name: "clip.webm", mimeType: "video/webm", buffer: clip }]);
    await page.click("#run-btn");
    await expect(page.locator(".result-item")).toHaveCount(1, { timeout: 90_000 });
    await expect(page.locator(".result-item .runtime-browser")).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(".btn-download").first().click()]);
    const buf = fs.readFileSync((await dl.path())!);
    const head = buf.subarray(0, 12).toString("latin1");
    expect(head.includes("ftyp") || buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true);
    expect(posts).toEqual([]);
    expect(errs).toEqual([]);
  });

  test("video → GIF via ffmpeg.wasm produces a GIF on the isolated site", async ({ page }) => {
    await page.goto("/convert-video");
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    const clip = await recordClip(page);
    await page.selectOption("#opt-format", "gif");
    await addFiles(page, [{ name: "clip.webm", mimeType: "video/webm", buffer: clip }]);
    await page.click("#run-btn");
    await expect(rowsDone(page)).toBeVisible({ timeout: 180_000 });
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(".btn-download").first().click()]);
    const buf = fs.readFileSync((await dl.path())!);
    expect(buf.subarray(0, 3).toString("latin1")).toBe("GIF");
  });

  test("a non-media file fails with a readable error, not a hang", async ({ page }) => {
    await page.goto("/convert-audio");
    await addFiles(page, [{ name: "noise.mp3", mimeType: "audio/mpeg", buffer: Buffer.alloc(400, 7) }]);
    await page.click("#run-btn");
    await expect(page.locator("#queue-body tr").first()).toHaveAttribute("data-status", "error", { timeout: 60_000 });
  });
});

const rowsDone = (page: Page) => page.locator(".result-item");
