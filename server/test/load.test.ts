import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noisyJpg, start, upload, waitJob, type Harness } from "./helpers.js";

/**
 * Load sanity for the 1 GB EC2 profile: a burst far above MAX_QUEUE must be shed with 429s (never OOM / hang),
 * everything that was accepted must finish, and resident memory must stay bounded.
 */
let h: Harness;
beforeAll(async () => {
  h = await start({ maxQueue: 20, lightConcurrency: 2, rateLimitMax: 10_000 });
});
afterAll(async () => {
  await h.cleanup();
});

describe("burst load", () => {
  it("60 simultaneous 2-3 MB image uploads: bounded queue, all accepted jobs finish, RSS stays under 900 MB", async () => {
    const photo = await noisyJpg(1400, 1000);
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
    const t0 = Date.now();
    const res = await Promise.all(
      Array.from({ length: 60 }, (_, i) => upload(h, "image-convert", [{ data: photo, name: `burst${i}.jpg` }], { format: "webp", quality: 70 }).then((r) => ({ status: r.status, id: r.body?.jobId as string | undefined }), (e: unknown) => ({ status: 0, id: undefined, err: String((e as Error)?.message ?? e).slice(0, 80) }))),
    );
    const accepted = res.filter((r) => r.status === 202);
    const shed = res.filter((r) => r.status === 429);
    const jobs = await Promise.all(accepted.map((r) => waitJob(h, r.id!, 120_000)));
    clearInterval(sampler);
    console.log("LOAD errors:", [...new Set(res.filter((r: any) => r.err).map((r: any) => r.err))].join(" | "));
    const mb = (b: number) => Math.round(b / 1048576);
    console.log(`LOAD accepted=${accepted.length} shed429=${shed.length} other=${res.length - accepted.length - shed.length} done=${jobs.filter((j) => j.status === "done").length} wall=${Date.now() - t0}ms peakRSS=${mb(peak)}MB input=${(photo.length / 1e6).toFixed(1)}MB`);
    expect(accepted.length).toBeGreaterThan(0);
    expect(shed.length).toBeGreaterThan(0); // the bound actually sheds load
    expect(res.every((r) => r.status === 202 || r.status === 429 || r.status === 0)).toBe(true);
    expect(accepted.length).toBeLessThanOrEqual(20 + 10); // maxQueue plus jobs that finished while the burst arrived
    expect(jobs.every((j) => j.status === "done")).toBe(true);
    expect(mb(peak)).toBeLessThan(900);
  }, 240_000);

  it("after the burst the server is idle again and accepts new work", async () => {
    expect(h.app.manager.active).toBe(0);
    const photo = await noisyJpg(300, 200);
    expect((await upload(h, "image-convert", [{ data: photo, name: "after.jpg" }], { format: "webp" })).status).toBe(202);
  });
});
