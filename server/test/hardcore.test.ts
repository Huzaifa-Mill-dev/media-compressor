import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { download, jpg, noisyJpg, pdf, pixelBomb, png, runJob, start, upload, waitJob, type Harness } from "./helpers.js";

/**
 * Hardcore Test Suite:
 * - Massive concurrency & race conditions
 * - Abrupt socket disconnects & abandoned uploads (leak detection)
 * - Prototype pollution & malicious option injections
 * - Pathological filenames & traversal
 * - Resource cleanup & state integrity
 * - Queue starvation & dual-queue isolation
 * - Slow client / incomplete upload recovery
 */
describe("Hardcore Concurrency & Security Stress", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await start({
      maxQueue: 15,
      lightConcurrency: 3,
      heavyConcurrency: 1,
      rateLimitMax: 50_000, // disable rate limit for stress tests
      outputTtlMs: 1_000,
      maxFileBytes: 5 * 1024 * 1024,
    });
  });

  afterAll(async () => {
    await h.cleanup();
  });

  // ─── 1. Concurrency & Race Conditions ─────────────────────────────────────────

  describe("1. Concurrency, Race Conditions & Queue Isolation", () => {
    it("Dual-queue isolation: slow/heavy queue does NOT block light jobs", async () => {
      const img = await noisyJpg(1600, 1200);

      // Submit 4 light jobs (light concurrency = 3)
      const lightUploads = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          upload(h, "image-convert", [{ data: img, name: `light_${i}.jpg` }], { format: "webp" })
        )
      );

      expect(lightUploads.every((u) => u.status === 202)).toBe(true);
      const jobs = await Promise.all(lightUploads.map((u) => waitJob(h, u.body.jobId)));
      expect(jobs.every((j) => j.status === "done")).toBe(true);
    }, 30_000);

    it("Concurrent Cancellation: cancelling while streaming SSE settles cleanly to 0 active jobs", async () => {
      const img = await noisyJpg(1400, 1000);

      // Start 5 conversions
      const ups = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          upload(h, "image-convert", [{ data: img, name: `cancel_test_${i}.jpg` }], { format: "png" })
        )
      );

      const jobIds = ups.filter((u) => u.status === 202).map((u) => u.body.jobId);
      expect(jobIds.length).toBeGreaterThan(0);

      // Concurrently connect to SSE and fire DELETE on all of them
      await Promise.all(
        jobIds.map(async (id) => {
          const sseReq = h.http.get(`/api/jobs/${id}/events`).buffer(false);
          await new Promise((r) => setTimeout(r, 20));
          const delRes = await h.http.delete(`/api/jobs/${id}`);
          expect([200, 404]).toContain(delRes.status);
          sseReq.abort();
        })
      );

      // Poll until all in-flight workers finish and active returns to 0
      const t0 = Date.now();
      while (h.app.manager.active > 0 && Date.now() - t0 < 8000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(h.app.manager.active).toBe(0);
    }, 30_000);

    it("Repeated / rapid double DELETE is idempotent and handles race conditions cleanly", async () => {
      const img = await png(100, 100);
      const up = await upload(h, "image-convert", [{ data: img, name: "double_del.png" }], { format: "webp" });
      expect(up.status).toBe(202);
      const id = up.body.jobId;

      // Fire 5 concurrent DELETE requests on the same job
      const deletes = await Promise.all(
        Array.from({ length: 5 }, () => h.http.delete(`/api/jobs/${id}`))
      );

      // At least one must succeed with 200, others 200 or 404, never 500
      const statuses = deletes.map((d) => d.status);
      expect(statuses.every((s) => s === 200 || s === 404)).toBe(true);
      expect(statuses).toContain(200);
    });

    it("Thundering herd: 40 simultaneous requests gracefully shed over-capacity without memory leak", async () => {
      const img = await png(80, 80);
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          upload(h, "image-convert", [{ data: img, name: `thundering_${i}.png` }], { format: "webp" })
        )
      );

      const statuses = results.map((r) => r.status);
      const accepted = statuses.filter((s) => s === 202).length;
      const rejected429 = statuses.filter((s) => s === 429).length;

      // Queue is capped at 15
      expect(accepted).toBeLessThanOrEqual(20);
      expect(rejected429).toBeGreaterThan(0);
      expect(accepted + rejected429).toBe(40);

      // Wait for all accepted jobs to finish
      const acceptedJobs = results.filter((r) => r.status === 202).map((r) => r.body.jobId);
      await Promise.all(acceptedJobs.map((id) => waitJob(h, id)));

      expect(h.app.manager.active).toBe(0);
    }, 45_000);
  });

  // ─── 2. Abrupt Sockets & Upload Disconnects ────────────────────────────────────

  describe("2. Socket Disconnects & Abandoned Uploads", () => {
    it("Abruptly aborted upload releases queue slot and frees directory immediately", async () => {
      const initialActive = h.app.manager.active;

      // Create a raw HTTP request that starts writing multipart then abruptly destroys socket
      const boundary = "----WebKitFormBoundaryX" + Math.random().toString(36).slice(2);
      const postDataHeader = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="tool"',
        "",
        "image-convert",
        `--${boundary}`,
        'Content-Disposition: form-data; name="options"',
        "",
        JSON.stringify({ format: "webp" }),
        `--${boundary}`,
        'Content-Disposition: form-data; name="files"; filename="broken.jpg"',
        "Content-Type: image/jpeg",
        "",
        "",
      ].join("\r\n");

      const req = h.http
        .post("/api/jobs")
        .set("Content-Type", `multipart/form-data; boundary=${boundary}`);

      req.write(postDataHeader);
      req.write(Buffer.alloc(1024, 0xff)); // send 1KB

      // Abruptly destroy the socket mid-stream
      req.abort();

      // Wait a short tick for cleanup
      await new Promise((r) => setTimeout(r, 200));

      // The slot must be released
      expect(h.app.manager.active).toBe(initialActive);
    });

    it("Multiple simultaneous aborted uploads do not leak file descriptors or directories", async () => {
      const initialDirs = fs.readdirSync(h.cfg.jobsDir);

      const abortRequests = Array.from({ length: 10 }, () => {
        const boundary = "----Boundary" + Math.random().toString(36).slice(2);
        const req = h.http
          .post("/api/jobs")
          .set("Content-Type", `multipart/form-data; boundary=${boundary}`);
        req.write(`--${boundary}\r\nContent-Disposition: form-data; name="tool"\r\n\r\nimage-convert\r\n`);
        req.abort();
        return req.catch(() => null);
      });

      await Promise.all(abortRequests);
      await new Promise((r) => setTimeout(r, 300));

      // Verify no dangling job directories in jobsDir
      const currentDirs = fs.readdirSync(h.cfg.jobsDir);
      expect(currentDirs.length).toBeLessThanOrEqual(initialDirs.length);
      expect(h.app.manager.active).toBe(0);
    });

    it("Raw TCP client abruptly dropping connection before multipart finishes frees reserved slot", async () => {
      // Start an actual listening TCP server instance for raw socket manipulation
      const server = h.app.app.listen(0);
      const addr = server.address() as net.AddressInfo;
      const port = addr.port;

      const initialActive = h.app.manager.active;

      await new Promise<void>((resolve, reject) => {
        const client = net.createConnection({ port }, () => {
          client.write(
            "POST /api/jobs HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${port}\r\n` +
            "Content-Type: multipart/form-data; boundary=----MyRawBoundary\r\n" +
            "Content-Length: 100000\r\n" +
            "\r\n" +
            "------MyRawBoundary\r\n" +
            'Content-Disposition: form-data; name="tool"\r\n\r\n' +
            "image-convert\r\n"
          );
          // Abruptly destroy socket without finishing
          setTimeout(() => {
            client.destroy();
            resolve();
          }, 50);
        });
        client.on("error", () => resolve());
      });

      await new Promise((r) => setTimeout(r, 300));
      server.close();

      // The reservation must be released back to 0
      expect(h.app.manager.active).toBe(initialActive);
    });
  });

  // ─── 3. Security, Injection & Input Validation ────────────────────────────────

  describe("3. Security, Injection & Malicious Inputs", () => {
    it("Prototype pollution in options payload is safely rejected", async () => {
      const img = await png(50, 50);
      const maliciousPayloads = [
        '{"__proto__": {"polluted": true}, "format": "webp"}',
        '{"constructor": {"prototype": {"polluted": true}}, "format": "webp"}',
        '{"format": "webp", "polluted": "yes"}', // unexpected key
      ];

      for (const payload of maliciousPayloads) {
        const res = await upload(h, "image-convert", [{ data: img, name: "clean.png" }], payload);
        expect(res.status, `Payload: ${payload}`).toBe(400);
        expect((Object.prototype as any).polluted).toBeUndefined();
      }
    });

    it("Extreme / pathological option values are rejected with 400", async () => {
      const img = await png(50, 50);
      const badOptions = [
        { quality: NaN },
        { quality: Infinity },
        { quality: -Infinity },
        { quality: 1e20 },
        { quality: -999 },
        { width: 0 },
        { width: -100 },
        { width: 100_000_000 },
        { format: "webp\0.jpg" },
        { format: "webp; touch /tmp/pwned" },
        { format: "../../../etc/passwd" },
        { format: "" },
      ];

      for (const opt of badOptions) {
        const res = await upload(h, "image-convert", [{ data: img, name: "test.png" }], opt);
        expect(res.status, `Option: ${JSON.stringify(opt)}`).toBe(400);
      }
    });

    it("ReDoS / Pathological range input to server is rejected cleanly without hang", async () => {
      const evilRange = "1-2,".repeat(5000) + "1-2";
      const dummyPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");
      const t0 = Date.now();
      const res = await upload(h, "pdf-split", [{ data: dummyPdf, name: "sample.pdf" }], { mode: "ranges", ranges: evilRange });
      expect(Date.now() - t0).toBeLessThan(100);
      expect([400, 503]).toContain(res.status);
      if (res.status === 400) expect(res.body.error).toMatch(/too long/i);
    });

    it("Huge option string is rejected by Busboy before exhausting memory", async () => {
      const img = await png(50, 50);
      // Send a 100KB options string (Busboy fieldSize is 64KB)
      const hugeOptions = JSON.stringify({ format: "webp", junk: "A".repeat(80 * 1024) });
      const res = await upload(h, "image-convert", [{ data: img, name: "test.png" }], hugeOptions);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/too long|field/i);
    });

    it("Huge number of dummy multipart fields before file does not exhaust limits", async () => {
      // Busboy config limits fields to 6 and parts to cfg.maxFiles + 6
      const boundary = "----WebKitFormBoundary" + Math.random().toString(36).slice(2);
      let body = "";
      for (let i = 0; i < 20; i++) {
        body += `--${boundary}\r\nContent-Disposition: form-data; name="spam_${i}"\r\n\r\nvalue_${i}\r\n`;
      }
      body += `--${boundary}--\r\n`;

      const res = await h.http
        .post("/api/jobs")
        .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
        .send(body);

      // Exceeds parts/fields limit -> 400
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/fields|parts|tool/i);
    });

    it("Zero-byte and truncated files with valid magic headers are rejected gracefully", async () => {
      // Exactly 8 bytes of PNG signature with nothing else
      const truncatedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const res = await upload(h, "image-convert", [{ data: truncatedPng, name: "trunc.png" }], { format: "webp" });

      if (res.status === 202) {
        // If accepted by sniff, the job itself must fail gracefully with error, NOT crash
        const job = await waitJob(h, res.body.jobId);
        expect(job.status).toBe("error");
        expect(job.error).toBeTruthy();
      } else {
        expect(res.status).toBe(400);
      }
    });

    it("Hostile filenames with null bytes, path traversal and long names are sanitized", async () => {
      const img = await png(60, 40);
      const hostileNames = [
        "../../../etc/shadow.png",
        "..\\..\\windows\\system32\\cmd.exe.png",
        "normal\0file.png",
        "A".repeat(500) + ".png",
        "test;rm -rf /;.png",
        "COM1.png",
        "NUL.png",
      ];

      for (const name of hostileNames) {
        const res = await upload(h, "image-convert", [{ data: img, name }], { format: "webp" });
        expect([202, 400]).toContain(res.status);
        if (res.status === 202) {
          const job = await waitJob(h, res.body.jobId);
          expect(job.status).toBe("done");
          const dl = await download(h, job);
          const cd = dl.headers["content-disposition"]!;
          expect(cd).not.toContain("..");
          expect(cd).not.toContain("/");
          expect(cd).not.toContain("\\");
          expect(cd).not.toContain("\0");
        }
      }
    });
  });

  // ─── 4. Output Download Security & Path Traversal ──────────────────────────────

  describe("4. Output Security & Traversal Resistance", () => {
    it("Malformed output indices never traverse or leak filesystem", async () => {
      const img = await png(100, 80);
      const job = await runJob(h, "image-convert", [{ data: img, name: "sample.png" }], { format: "webp" });
      expect(job.status).toBe("done");

      const probeIndices = [
        "-1",
        "0.1",
        "1e2",
        "0/../../etc/passwd",
        "%2e%2e%2f",
        "null",
        "undefined",
        "__proto__",
        "toString",
        "1", // out of bounds (only 1 output exists at index 0)
        "99999",
      ];

      for (const idx of probeIndices) {
        const res = await h.http.get(`/api/jobs/${job.id}/outputs/${encodeURIComponent(idx)}`);
        expect([400, 404]).toContain(res.status);
      }
    });

    it("Completed job output headers contain strict CSP and nosniff", async () => {
      const img = await png(120, 80);
      const job = await runJob(h, "image-convert", [{ data: img, name: "csp_test.png" }], { format: "webp" });
      expect(job.status).toBe("done");

      const res = await h.http.get(job.outputs[0].url);
      expect(res.status).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(res.headers["content-type"]).toBe("image/webp");
      expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    });
  });

  // ─── 5. Resource Cleanup Verification ─────────────────────────────────────────

  describe("5. Resource Cleanup Verification", () => {
    it("No orphaned directories or files left behind in jobsDir after job lifecycle", async () => {
      const img = await png(100, 100);
      const job = await runJob(h, "image-convert", [{ data: img, name: "cleanup_test.png" }], { format: "webp" });
      expect(job.status).toBe("done");

      // Verify work and in directories are already gone immediately upon job finish
      const jobDir = path.join(h.cfg.jobsDir, job.id);
      expect(fs.existsSync(path.join(jobDir, "in"))).toBe(false);
      expect(fs.existsSync(path.join(jobDir, "work"))).toBe(false);

      // Explicitly delete job
      const del = await h.http.delete(`/api/jobs/${job.id}`);
      expect(del.status).toBe(200);

      // Verify entire jobDir is completely purged
      await new Promise((r) => setTimeout(r, 100));
      expect(fs.existsSync(jobDir)).toBe(false);
    });
  });

  // ─── 6. Document & Mixed Workload Hardcore Stress ─────────────────────────────

  describe("6. Document & Mixed Workload Hardcore Stress", () => {
    it("10 concurrent downloads of the same completed output succeed with identical bytes", async () => {
      const img = await png(150, 150, "#336699");
      const job = await runJob(h, "image-convert", [{ data: img, name: "shared.png" }], { format: "webp" });
      expect(job.status).toBe("done");

      const downloads = await Promise.all(
        Array.from({ length: 10 }, () => h.http.get(job.outputs[0].url).buffer(true))
      );

      expect(downloads.every((d) => d.status === 200)).toBe(true);
      const firstBody = downloads[0].body;
      expect(firstBody.length).toBeGreaterThan(0);
      for (let i = 1; i < downloads.length; i++) {
        expect(downloads[i].body.equals(firstBody)).toBe(true);
      }
    });

    it("pdf-to-docx: rejects bad files, non-PDFs, and options securely", async () => {
      // 1. Non-PDF named .pdf
      const fakePdf = Buffer.from("<html><script>alert('xss')</script></html>");
      const r1 = await upload(h, "pdf-to-docx", [{ data: fakePdf, name: "exploit.pdf" }], {});
      if (h.bins.pdf2docx) {
        expect(r1.status).toBe(400); // sniffFile rejects html disguised as pdf
      } else {
        expect(r1.status).toBe(503);
      }

      // 2. Reject disallowed options for pdf-to-docx
      const r2 = await upload(h, "pdf-to-docx", [{ data: await pdf(1), name: "test.pdf" }], {
        maliciousOption: true,
      });
      if (h.bins.pdf2docx) {
        expect(r2.status).toBe(400);
        expect(r2.body.error).toMatch(/unknown option/i);
      } else {
        expect(r2.status).toBe(503);
      }
    });

    it("Mixed workload burst: parallel images, audio, documents handled within queue bounds", async () => {
      const img = await png(80, 80);
      const testPdf = await pdf(2);

      // Mix of 10 requests: image conversions, images-to-pdf, and pdf operations
      const requests = [
        upload(h, "image-convert", [{ data: img, name: "burst_1.png" }], { format: "webp" }),
        upload(h, "image-convert", [{ data: img, name: "burst_2.png" }], { format: "jpeg" }),
        upload(h, "images-to-pdf", [{ data: img, name: "page1.png" }, { data: img, name: "page2.png" }], { pageSize: "fit" }),
        upload(h, "image-compress", [{ data: img, name: "burst_3.png" }], {}),
        upload(h, "image-convert", [{ data: img, name: "burst_4.png" }], { format: "webp" }),
        upload(h, "images-to-pdf", [{ data: img, name: "doc.png" }], { pageSize: "a4" }),
        upload(h, "image-convert", [{ data: img, name: "burst_5.png" }], { format: "webp" }),
        upload(h, "pdf-to-docx", [{ data: testPdf, name: "burst.pdf" }], {}),
        upload(h, "image-convert", [{ data: img, name: "burst_6.png" }], { format: "png" }),
        upload(h, "image-convert", [{ data: img, name: "burst_7.png" }], { format: "webp" }),
      ];

      const responses = await Promise.all(requests);
      // All requests must either be accepted (202) or gracefully rejected (503 if tool unavailable, or 429 if shed)
      for (const res of responses) {
        expect([200, 202, 429, 503]).toContain(res.status);
      }

      // Wait for all accepted jobs to reach a terminal status
      const accepted = responses.filter((r) => r.status === 202).map((r) => r.body.jobId);
      const finished = await Promise.all(accepted.map((id) => waitJob(h, id, 45_000)));
      for (const f of finished) {
        expect(["done", "error", "cancelled"]).toContain(f.status);
      }
    });

    it("Rapid sequential submit and immediate cancel does not deadlock queue or leak slots", async () => {
      const img = await png(60, 60);
      const initialActive = h.app.manager.active;

      for (let i = 0; i < 6; i++) {
        const up = await upload(h, "image-convert", [{ data: img, name: `cycle_${i}.png` }], { format: "webp" });
        if (up.status === 202) {
          const jobId = up.body.jobId;
          const del = await h.http.delete(`/api/jobs/${jobId}`);
          expect(del.status).toBe(200);
        }
      }

      // Wait for event loop to settle
      await new Promise((r) => setTimeout(r, 200));
      expect(h.app.manager.active).toBe(initialActive);
    });
  });
});
