import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import busboy from "busboy";
import express, { type NextFunction, type Request, type Response } from "express";
import type { ServerConfig } from "./config.js";
import { badRequest, HttpError } from "./errors.js";
import { isTerminal, JobManager, publicJob, type Job } from "./jobs.js";
import { createLogger } from "./log.js";
import type { Binaries } from "./probe.js";
import type { ProcInput } from "./processors/types.js";
import { sniffFile } from "./sniff.js";
import { Stats } from "./stats.js";
import { availableTools, crossValidate, isToolId, resolveOptions, SERVER_TOOLS, toolAvailable } from "./tools.js";
import { contentDisposition, extOf, sanitizeFilename } from "./util.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DRAIN_CAP = 64 * 1024 * 1024;

export interface App {
  app: express.Express;
  manager: JobManager;
  stats: Stats;
  close(): Promise<void>;
}

/** Fixed-window per-IP limiter (in memory; one process). */
function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  const mw = (req: Request, _res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    let h = hits.get(key);
    if (!h || h.reset <= now) hits.set(key, (h = { n: 0, reset: now + windowMs }));
    if (++h.n > max) return next(new HttpError(429, "Too many requests. Please slow down.", "rate_limited"));
    next();
  };
  return { mw, stop: () => clearInterval(sweep) };
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  next();
}

export async function createApp(cfg: ServerConfig, bins: Binaries): Promise<App> {
  const log = createLogger(cfg.logLevel);
  const stats = new Stats(cfg.dataDir);
  const manager = new JobManager(cfg, bins, stats, log);
  await manager.sweep();
  const limiter = rateLimiter(cfg.rateLimitMax, cfg.rateLimitWindowMs);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", cfg.trustProxy);
  app.use(securityHeaders);

  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  api.get("/health", (_req, res) => void res.json({ ok: true, version: cfg.version }));
  api.get("/capabilities", (_req, res) => void res.json({ tools: availableTools(bins), limits: { maxFileBytes: cfg.maxFileBytes, maxFiles: cfg.maxFiles } }));
  api.get("/stats", (_req, res) => void res.json(stats.toJSON()));

  // ---- upload ----------------------------------------------------------------------------------
  api.post("/jobs", limiter.mw, (req, res, next) => {
    let release: () => void;
    try {
      release = manager.reserve();
    } catch (e) {
      return next(e);
    }
    const ct = req.headers["content-type"] ?? "";
    if (!/^multipart\/form-data/i.test(ct)) {
      release();
      return next(badRequest("Send a multipart/form-data request"));
    }
    const { id, dir } = manager.newJobDir();
    const inDir = path.join(dir, "in");
    const inputs: ProcInput[] = [];
    const pending: Promise<void>[] = [];
    const fields: Record<string, string> = {};
    let total = 0;
    let failure: Error | null = null;
    let settled = false;

    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers,
        defParamCharset: "utf8",
        limits: { fileSize: cfg.maxFileBytes, files: cfg.maxFiles, fields: 6, fieldSize: 64 * 1024, parts: cfg.maxFiles + 6, headerPairs: 50 },
      });
    } catch {
      release();
      return next(badRequest("Malformed multipart request"));
    }

    const fail = (err: Error) => {
      if (failure) return;
      failure = err;
      req.unpipe(bb);
      let drained = 0;
      req.on("data", (c: Buffer) => {
        drained += c.length;
        if (drained > DRAIN_CAP) req.destroy();
      });
      req.resume();
      void settle();
    };

    const settle = async () => {
      if (settled) return;
      settled = true;
      await Promise.allSettled(pending);
      try {
        if (failure) throw failure;
        const toolId = fields.tool;
        if (!isToolId(toolId)) throw badRequest("Unknown tool");
        const tool = SERVER_TOOLS[toolId];
        if (!toolAvailable(tool, bins)) throw new HttpError(503, "This tool isn't available on the server right now", "tool_unavailable");
        let rawOpts: unknown = {};
        if (fields.options !== undefined && fields.options !== "") {
          try {
            rawOpts = JSON.parse(fields.options);
          } catch {
            throw badRequest("options must be valid JSON");
          }
        }
        const options = resolveOptions(tool, rawOpts);
        if (inputs.length === 0) throw badRequest("Attach at least one file");
        if (!tool.multiInput && inputs.length !== 1) throw badRequest(`${tool.id} takes exactly one file`);
        for (const f of inputs) {
          if (!tool.accepts.includes(f.ext)) throw badRequest(`.${f.ext || "?"} files aren't supported by ${tool.id}`);
        }
        crossValidate(tool, options, inputs.map((i) => i.ext));
        for (const f of inputs) await sniffFile(f.path, f.ext, f.size, f.name);
        const job: Job = {
          id,
          tool,
          options,
          dir,
          inputs,
          status: "queued",
          percent: 0,
          outputs: [],
          inputBytes: inputs.reduce((a, f) => a + f.size, 0),
          abort: new AbortController(),
        };
        release();
        manager.submit(job);
        if (!res.headersSent) res.status(202).json({ jobId: id });
      } catch (e) {
        release();
        await fsp.rm(dir, { recursive: true, force: true });
        if (!res.headersSent) next(e);
      }
    };

    bb.on("field", (name, val, info) => {
      if (info.valueTruncated) return fail(badRequest(`Field ${name.slice(0, 20)} is too long`));
      if (["tool", "options"].includes(name)) fields[name] = val;
    });
    bb.on("file", (name, stream, info) => {
      if (name !== "files") {
        stream.resume();
        return;
      }
      const display = sanitizeFilename(info.filename || "file");
      const ext = extOf(display);
      const idx = inputs.length;
      if (!ext) {
        stream.resume();
        return fail(badRequest(`${display.slice(0, 60)} has no supported file extension`));
      }
      const file = path.join(inDir, `${idx}.${ext}`);
      const entry: ProcInput = { path: file, name: display, ext, size: 0 };
      inputs.push(entry);
      const p = (async () => {
        await fsp.mkdir(inDir, { recursive: true });
        const out = fs.createWriteStream(file, { flags: "wx", mode: 0o600 });
        stream.on("data", (c: Buffer) => {
          entry.size += c.length;
          total += c.length;
          if (total > cfg.maxTotalBytes) fail(new HttpError(413, "The upload is too large", "too_large"));
        });
        stream.on("limit", () => fail(new HttpError(413, `${display.slice(0, 60)} is larger than the ${Math.round(cfg.maxFileBytes / 1048576)} MB limit`, "too_large")));
        await new Promise<void>((resolve, reject) => {
          stream.pipe(out);
          out.on("finish", resolve);
          out.on("error", reject);
          stream.on("error", reject);
        });
      })();
      pending.push(p.catch((e) => fail(e instanceof Error ? e : new Error(String(e)))));
    });
    bb.on("filesLimit", () => fail(badRequest(`Too many files (max ${cfg.maxFiles})`)));
    bb.on("partsLimit", () => fail(badRequest("Too many form fields")));
    bb.on("error", (e) => fail(badRequest(`Upload failed: ${(e as Error).message.slice(0, 80)}`)));
    bb.on("close", () => void settle());
    req.on("aborted", () => {
      failure ??= new Error("client aborted");
      void settle();
    });
    req.pipe(bb);
  });

  // ---- job access (ids are random UUIDs; files are only reachable through them) -----------------
  const findJob = (req: Request): Job => {
    const id = String(req.params.id);
    const job = UUID.test(id) ? manager.get(id) : undefined;
    if (!job) throw new HttpError(404, "Job not found", "not_found");
    return job;
  };
  const view = (j: Job) => publicJob(j, manager.position(j));

  api.get("/jobs/:id", (req, res) => void res.json(view(findJob(req))));

  api.get("/jobs/:id/events", (req, res) => {
    const job = findJob(req);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = () => res.write(`data: ${JSON.stringify(view(job))}\n\n`);
    const finishIfDone = () => {
      if (isTerminal(job.status)) {
        cleanup();
        res.end();
      }
    };
    const onChange = (id: string) => {
      if (id !== job.id) return;
      send();
      finishIfDone();
    };
    const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
    const cleanup = () => {
      clearInterval(beat);
      manager.off("change", onChange);
    };
    manager.on("change", onChange);
    req.on("close", cleanup);
    send();
    finishIfDone();
  });

  api.get("/jobs/:id/outputs/:index", (req, res) => {
    const job = findJob(req);
    const idx = /^\d{1,4}$/.test(String(req.params.index)) ? Number(req.params.index) : -1;
    const out = job.status === "done" ? job.outputs[idx] : undefined;
    if (!out) throw new HttpError(404, "Output not found", "not_found");
    // Defence in depth: the path comes from our own record, but still verify it sits inside the job dir.
    const resolved = path.resolve(out.path);
    if (!resolved.startsWith(path.resolve(job.dir) + path.sep)) throw new HttpError(404, "Output not found", "not_found");
    const stream = fs.createReadStream(resolved);
    stream.on("open", () => {
      res.setHeader("Content-Type", out.mime);
      res.setHeader("Content-Length", out.size);
      res.setHeader("Content-Disposition", contentDisposition(out.name));
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      stream.pipe(res);
    });
    stream.on("error", () => {
      if (!res.headersSent) res.status(404).json({ error: "Output not found", code: "not_found" });
      else res.destroy();
    });
    res.on("close", () => stream.destroy());
  });

  api.delete("/jobs/:id", (req, res) => {
    const job = findJob(req);
    manager.cancel(job);
    if (isTerminal(job.status)) manager.remove(job.id);
    res.json({ ok: true });
  });

  api.use((_req, _res, next) => next(new HttpError(404, "Not found", "not_found")));
  app.use("/api", api);

  // ---- static site -----------------------------------------------------------------------------
  if (fs.existsSync(cfg.webDist)) {
    app.use(
      express.static(cfg.webDist, {
        index: "index.html",
        extensions: ["html"],
        setHeaders(res, file) {
          if (file.includes(`${path.sep}_astro${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          else if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
          else if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
        },
      }),
    );
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      const notFound = path.join(cfg.webDist, "404.html");
      if (fs.existsSync(notFound)) return void res.status(404).sendFile(notFound);
      next();
    });
  }

  // ---- errors ----------------------------------------------------------------------------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (res.headersSent) return void res.destroy();
    if (err instanceof HttpError) {
      res.status(err.status);
      if (err.status === 413 || err.status === 429) res.setHeader("Connection", "close");
      return void res.json({ error: err.message, code: err.code });
    }
    log.error("unhandled", { err: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    res.status(500).json({ error: "Internal server error" });
  });

  return {
    app,
    manager,
    stats,
    async close() {
      limiter.stop();
      stats.flush();
      await manager.close();
    },
  };
}
