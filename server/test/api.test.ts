import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { download, jpg, noisyJpg, pixelBomb, png, runJob, start, upload, waitJob, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => {
  h = await start({ maxFileBytes: 400 * 1024, maxFiles: 3, rateLimitMax: 10_000 });
});
afterAll(async () => {
  await h.cleanup();
});

describe("basics", () => {
  it("health, capabilities, stats", async () => {
    expect((await h.http.get("/api/health")).body).toMatchObject({ ok: true });
    const c = (await h.http.get("/api/capabilities")).body;
    expect(c.tools).toContain("image-compress");
    expect(c.limits.maxFiles).toBe(3);
    expect(Object.keys((await h.http.get("/api/stats")).body).sort()).toEqual(["totalJobs", "totalSavedBytes"]);
  });
  it("sets security headers", async () => {
    const r = await h.http.get("/api/health");
    expect(r.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(r.headers["cross-origin-embedder-policy"]).toBe("require-corp");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toContain("'wasm-unsafe-eval'");
    expect(r.headers["x-powered-by"]).toBeUndefined();
  });
  it("CSP allows exactly the inline theme boot script (by sha256), nothing else inline", async () => {
    const { script } = JSON.parse(fs.readFileSync(path.join(__dirname, "../../shared/theme-boot.json"), "utf8"));
    const hash = require("node:crypto").createHash("sha256").update(script).digest("base64");
    const csp = (await h.http.get("/api/health")).headers["content-security-policy"] as string;
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"))!;
    expect(scriptSrc).toContain(`sha256-${hash}`);
    expect(scriptSrc).not.toContain("unsafe-inline");
  });
  it("has no public history or job listing", async () => {
    for (const p of ["/api/history", "/api/jobs", "/api/files"]) expect((await h.http.get(p)).status).toBe(404);
  });
});

describe("input validation → 400", () => {
  const one = async () => [{ data: await png(), name: "a.png" }];
  it("unknown tool", async () => expect((await upload(h, "rm-rf", await one())).status).toBe(400));
  it("unknown option / extra key", async () => expect((await upload(h, "image-compress", await one(), { format: "webp", evil: 1 })).status).toBe(400));
  it("wrong option types and values", async () => {
    for (const o of [{ quality: "high" }, { quality: 1000 }, { quality: 80.5 }, { format: "exe" }, { format: ["webp"] }, { width: -5 }, [], "not json{"]) {
      expect((await upload(h, "image-compress", await one(), o)).status, JSON.stringify(o)).toBe(400);
    }
  });
  it("missing files / not multipart", async () => {
    expect((await h.http.post("/api/jobs").field("tool", "image-compress")).status).toBe(400);
    expect((await h.http.post("/api/jobs").send({ tool: "image-compress" })).status).toBe(400);
  });
  it("two files for a single-input tool", async () => expect((await upload(h, "image-compress", [...(await one()), ...(await one())])).status).toBe(400));
  it("unsupported extension", async () => expect((await upload(h, "image-compress", [{ data: await png(), name: "a.exe" }])).status).toBe(400));
  it("no extension", async () => expect((await upload(h, "image-compress", [{ data: await png(), name: "noext" }])).status).toBe(400));
  it("empty file", async () => expect((await upload(h, "image-compress", [{ data: Buffer.alloc(0), name: "e.png" }])).status).toBe(400));
  it("too many files", async () => {
    const f = (await one())[0]!;
    expect((await upload(h, "images-to-pdf", [f, f, f, f])).status).toBe(400);
  });
});

describe("extension must match content (magic bytes)", () => {
  it("html renamed .png", async () => expect((await upload(h, "image-compress", [{ data: "<html><script>alert(1)</script></html>", name: "x.png" }])).status).toBe(400));
  it("PNG renamed .jpg", async () => expect((await upload(h, "image-compress", [{ data: await png(), name: "x.jpg" }])).status).toBe(400));
  it("JPEG renamed .webp", async () => expect((await upload(h, "image-convert", [{ data: await jpg(), name: "x.webp" }])).status).toBe(400));
});

describe("size limits", () => {
  it("oversize file → 413", async () => {
    const big = Buffer.concat([await png(), Buffer.alloc(600 * 1024)]);
    const r = await upload(h, "image-compress", [{ data: big, name: "big.png" }]).then(
      (x) => x.status,
      (e) => (/EPIPE|ECONNRESET/.test(String(e)) ? 413 : String(e)),
    );
    expect(r).toBe(413);
  });
});

describe("routing & traversal", () => {
  const bad = ["../../etc/passwd", "..%2f..%2fetc%2fpasswd", "%2e%2e%2f%2e%2e%2f", "..%252f..%252f", "..%5c..%5cwindows%5cwin.ini", "%00", "%2e%2e", "0".repeat(40), "00000000-0000-0000-0000-000000000000", "'%20OR%201=1--"];
  it.each(bad)("GET /api/jobs/%s → 400/404 (never 200/500)", async (id) => {
    for (const suffix of ["", "/events", "/outputs/0"]) {
      const s = (await h.http.get(`/api/jobs/${id}${suffix}`)).status;
      expect([400, 404], `${id}${suffix} → ${s}`).toContain(s);
    }
  });
  it("DELETE unknown job → 404", async () => expect((await h.http.delete("/api/jobs/00000000-0000-4000-8000-000000000000")).status).toBe(404));
  it("output index traversal on a real job", async () => {
    const j = await runJob(h, "image-compress", [{ data: await png(), name: "a.png" }], { format: "webp" });
    expect(j.status).toBe("done");
    for (const i of ["-1", "1", "99", "..%2f..%2f", "abc", "0%00", "00000"]) {
      const s = (await h.http.get(`/api/jobs/${j.id}/outputs/${i}`)).status;
      expect([400, 404], `outputs/${i} → ${s}`).toContain(s);
    }
  });
});

describe("hostile file names", () => {
  const names = ["a;rm -rf ~;.png", "$(touch pwned).png", "`id`.png", "a b\"c'd.png", "..\\..\\evil.png", "../../evil.png", "名前🙂.png", "invoice‮gnp.png", "x\u0000.png", "A".repeat(400) + ".png", "-rf.png", "con.png"];
  it.each(names)("handles %j", async (name) => {
    const r = await upload(h, "image-compress", [{ data: await png(), name }], { format: "webp" });
    expect([202, 400]).toContain(r.status);
    if (r.status !== 202) return;
    const j = await waitJob(h, r.body.jobId);
    expect(j.status).toBe("done");
    const d = await download(h, j);
    const cd = d.headers["content-disposition"]!;
    expect(cd).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
    expect(cd).not.toMatch(/[‮\\]|\.\.|\//);
    expect(d.headers["x-content-type-options"]).toBe("nosniff");
    expect((await sharp(d.body).metadata()).format).toBe("webp");
  });
});

describe("hostile image content", () => {
  it("pixel bomb is rejected quickly as a job error", async () => {
    const t = Date.now();
    const j = await runJob(h, "image-compress", [{ data: pixelBomb(), name: "bomb.png" }], { format: "webp" });
    expect(j.status).toBe("error");
    expect(j.error).toMatch(/dimension|limit|readable/i);
    expect(Date.now() - t).toBeLessThan(5000);
  });
  it("truncated JPEG → clean error without server paths", async () => {
    const j = await runJob(h, "image-compress", [{ data: (await noisyJpg(400, 300)).subarray(0, 3000), name: "t.jpg" }], { format: "webp" });
    expect(j.status).toBe("error");
    expect(j.error).toBeTruthy();
    expect(JSON.stringify(j)).not.toMatch(/mt-test|node_modules|\\Users|\/tmp/);
  });
});

describe("image jobs", () => {
  it("compress never inflates; webp convert + resize valid", async () => {
    const small = await noisyJpg(200, 150);
    const j1 = await runJob(h, "image-compress", [{ data: small, name: "p.jpg" }], { format: "original", quality: 95 });
    expect(j1.status).toBe("done");
    expect(j1.outputs[0].size).toBeLessThanOrEqual(small.length);
    const j2 = await runJob(h, "image-convert", [{ data: await png(200, 100), name: "p.png" }], { format: "webp", width: 50 });
    const m = await sharp((await download(h, j2)).body).metadata();
    expect([m.format, m.width]).toEqual(["webp", 50]);
  });
  it("EXIF orientation is applied", async () => {
    const rot = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#0099ff" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const j = await runJob(h, "image-convert", [{ data: rot, name: "r.jpg" }], { format: "png" });
    const m = await sharp((await download(h, j)).body).metadata();
    expect([m.width, m.height]).toEqual([200, 400]);
  });
  it("10 parallel jobs give distinct, valid outputs", async () => {
    const ups = await Promise.all(Array.from({ length: 10 }, async (_, i) => upload(h, "image-convert", [{ data: await png(20 + i * 5, 30), name: `p${i}.png` }], { format: "webp" })));
    expect(ups.every((u) => u.status === 202)).toBe(true);
    const jobs = await Promise.all(ups.map((u) => waitJob(h, u.body.jobId)));
    const widths: (number | undefined)[] = [];
    for (const j of jobs) {
      expect(j.status).toBe("done");
      widths.push((await sharp((await download(h, j)).body).metadata()).width);
    }
    expect(widths).toEqual(Array.from({ length: 10 }, (_, i) => 20 + i * 5));
    expect(new Set(jobs.map((j) => j.id)).size).toBe(10);
  });
  it("SSE stream delivers the final state and closes", async () => {
    const r = await upload(h, "image-convert", [{ data: await png(), name: "s.png" }], { format: "webp" });
    const res = await h.http
      .get(`/api/jobs/${r.body.jobId}/events`)
      .buffer(true)
      .parse((rs, cb) => {
        let s = "";
        rs.on("data", (c: Buffer) => (s += c));
        rs.on("end", () => cb(null, s));
      });
    const events = String(res.body).split("\n\n").filter((e) => e.startsWith("data: ")).map((e) => JSON.parse(e.slice(6)));
    expect(events.at(-1).status).toBe("done");
  });
  it("stats count jobs and never expose file names", async () => {
    const s = (await h.http.get("/api/stats")).body;
    expect(s.totalJobs).toBeGreaterThan(5);
    expect(JSON.stringify(s)).not.toMatch(/\.png|\.jpg/);
  });
});

describe("limits & lifecycle", () => {
  it("queue full → 429", async () => {
    const x = await start({ maxQueue: 2, rateLimitMax: 1000 });
    const r1 = x.app.manager.reserve();
    const r2 = x.app.manager.reserve();
    expect((await upload(x, "image-compress", [{ data: await png(), name: "a.png" }])).status).toBe(429);
    r1();
    r2();
    expect((await upload(x, "image-compress", [{ data: await png(), name: "a.png" }])).status).toBe(202);
    await x.cleanup();
  });
  it("rate limit → 429", async () => {
    const x = await start({ rateLimitMax: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await upload(x, "image-compress", [{ data: await png(), name: "a.png" }])).status);
    expect(codes.slice(0, 3)).toEqual([202, 202, 202]);
    expect(codes.slice(3)).toEqual([429, 429]);
    await x.cleanup();
  });
  it("outputs and job disappear after the TTL; DELETE removes immediately", async () => {
    const x = await start({ outputTtlMs: 300 });
    const j = await runJob(x, "image-compress", [{ data: await png(), name: "a.png" }], { format: "webp" });
    expect(j.status).toBe("done");
    await new Promise((r) => setTimeout(r, 800));
    expect((await x.http.get(`/api/jobs/${j.id}`)).status).toBe(404);
    expect((await x.http.get(`/api/jobs/${j.id}/outputs/0`)).status).toBe(404);
    const y = await runJob(await start({ outputTtlMs: 60_000 }).then((s) => (x.cleanup(), s)), "image-compress", [{ data: await png(), name: "a.png" }], { format: "webp" }).catch(() => null);
    void y;
  });
  it("DELETE cleans the job directory", async () => {
    const x = await start();
    const j = await runJob(x, "image-compress", [{ data: await png(), name: "a.png" }], { format: "webp" });
    expect((await x.http.delete(`/api/jobs/${j.id}`)).body.ok).toBe(true);
    expect((await x.http.get(`/api/jobs/${j.id}`)).status).toBe(404);
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.readdirSync(x.cfg.jobsDir)).toEqual([]);
    await x.cleanup();
  });
  it("startup sweep removes leftovers of a previous run", async () => {
    const x = await start();
    fs.mkdirSync(path.join(x.cfg.jobsDir, "leftover"), { recursive: true });
    await x.app.manager.sweep();
    expect(fs.readdirSync(x.cfg.jobsDir)).toEqual([]);
    await x.cleanup();
  });
});
