# Media Toolkit — Rebuild Plan & Contracts

Goal: a public, free alternative to paywalled converters/compressors. **Browser-first**: every job that
can run on the user's device does (WASM + WebCodecs, parallel workers). The EC2 server (1 GB RAM, 1–2 slow
vCPUs) is only a fallback for jobs browsers can't do (Office docs, PDF compression, very large media).

Speed target: 3 typical images (2–5 MB each) compressed in **< 5 s total** on a mid-range laptop, processed
in parallel — beating the current one-at-a-time ~10 s/image server path.

## Layout & ownership (strict — do not edit outside your area)

| Path | Owner | What |
|---|---|---|
| `engine/src/types.ts`, `docs/PLAN.md` | **lead** | Shared contracts. Read-only for agents. |
| `engine/` (rest) | **engine agent** | Framework-agnostic TS: tool registry, worker pool, browser processors, server client, routing. Own `package.json`. |
| `web/public/vendor/` | **engine agent** (via `engine/scripts/copy-assets.mjs`) | WASM/worker assets copied at build. |
| `web/` (rest) | **UI agent** | Astro + TS site. Own `package.json`. Imports engine only via `engine/src/index.ts`. |
| `server/`, root `package.json`, `Dockerfile`, `.github/` | **server agent** | Express + TS fallback API. Old `server.js`/`public/` are removed by this agent once ported. |
| `tests/` | **QA agent** (phase 2) | Cross-cutting adversarial + e2e tests. |

Rules for every agent:
- Never `git commit`/`push`/`checkout` — the lead commits. Never run `git add -A` or `git stash`.
- Pin exact dependency versions. No CDN loads at runtime: everything is self-hosted (pages are cross-origin isolated).
- No `exec`/shell strings with user data — `execFile`/`spawn` with arg arrays only.
- Never put user-controlled strings into `innerHTML` (filenames, errors, metadata).
- Tests must exercise real files and real codecs, not mocks of the thing under test.
- Ports: server tests use ephemeral ports (`listen(0)`); Astro dev 4321; engine browser tests 63315.

## Engine API

See `engine/src/types.ts` (`Engine`, `ToolDefinition`, `JobInput`, `JobResult`). `engine/src/index.ts`
exports `createEngine(opts?: { serverBaseUrl?: string; concurrency?: number }): Engine` and the `tools` array.

Browser implementations (recommended libraries, all pinned):
- Images: `@jsquash/{webp,avif,jpeg,png,oxipng,resize}` in a Web Worker pool, concurrency
  `clamp(hardwareConcurrency - 1, 1, 4)`. HEIC input via `heic-to` / `libheif-js`. GIF/BMP/TIFF read via
  `createImageBitmap` where the browser supports it, else server.
- Video/audio: **`mediabunny` (WebCodecs, hardware encoders) is the fast path**. `@ffmpeg/ffmpeg` +
  `@ffmpeg/core-mt` (needs cross-origin isolation) is the fallback for codecs/containers WebCodecs can't do
  (e.g. MOV/AVI demux edge cases, FLAC/WAV/MP3 encode, video→GIF). Files above `browserMaxBytes` → server.
- Fonts: `wawoff2` (woff2 ↔ sfnt) + hand-rolled WOFF1 (zlib via `fflate`). TTF↔OTF outline conversion is server-only (fontTools).
- PDF: `pdf-lib` (merge, split, images-to-pdf), `pdfjs-dist` (pdf-to-images). Compression → server (Ghostscript).
- Documents: server LibreOffice. (Optional browser path: docx → html/txt via `mammoth`.)
- Spreadsheets: `exceljs` in browser for xlsx ↔ csv ↔ json; xls/ods/pdf → server LibreOffice.

## Server HTTP API (fallback runtime)

All responses JSON unless noted. Tool ids and option keys are identical to the engine registry.

- `GET  /api/health` → `{ ok: true, version }`
- `GET  /api/capabilities` → `{ tools: ToolId[], limits: { maxFileBytes, maxFiles } }` (only tools whose
  binaries are actually present: ffmpeg, gs, qpdf, soffice, python3+fontTools).
- `POST /api/jobs` multipart: `tool` (ToolId), `options` (JSON string), `files` (1..n). Validates tool,
  options, file count, size, extension **and magic bytes**. → `202 { jobId }`. 400 on invalid input,
  413 too large, 429 rate-limited / queue full.
- `GET  /api/jobs/:id` → `{ id, tool, status: "queued"|"processing"|"done"|"error"|"cancelled", percent, message,
  queuePosition?, outputs?: [{ name, size, mime, url }], meta?, error? }`
- `GET  /api/jobs/:id/events` → SSE stream of the same object on every change; closes at a terminal status.
- `GET  /api/jobs/:id/outputs/:index` → the file (`Content-Disposition: attachment`, safe filename).
- `DELETE /api/jobs/:id` → cancel; kills the child process; `{ ok: true }`.
- `GET  /api/stats` → aggregate only `{ totalJobs, totalSavedBytes }` (no filenames — the old public
  per-file history leaked other users' filenames and is removed; per-user history lives in localStorage).

Job ids are unguessable (`crypto.randomUUID()`); a job's files are only reachable through its id.
Inputs/outputs live in a per-job temp dir, deleted after download TTL (30 min) or on cancel/error.
Queue: heavy tools (video, LibreOffice, gs) concurrency 1; light tools concurrency 2; bounded queue length.
Every child process has a timeout and memory guard. Headers: COOP `same-origin`, COEP `require-corp`, CSP,
`nosniff`. Static: serves `web/dist`.
