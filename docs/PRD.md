# PRD — Media Toolkit (public rebuild of `media-compressor`)

> Handoff document. A fresh agent should be able to continue the work from this file alone.
> Read order: this file → `docs/PLAN.md` (contracts, ownership) → `engine/src/types.ts` (type contract) → `engine/src/tools.ts` (tool registry, source of truth for option keys).
> Branch: `claude/exciting-brahmagupta-bskdm1`. Repo: `huzaifa-mill-dev/media-compressor`. Do NOT merge to `main` or open a PR unless the user asks — `main` auto-deploys to production EC2.

---

## 1. Product

**What:** A free, public alternative to paywalled converter/compressor sites (TinyPNG, CloudConvert, iLovePDF, Smallpdf…). Users drop files, pick options, get compressed/converted files back. No account, no paywall.

**Why it's being rebuilt:** The existing tool (Express + sharp + FFmpeg on a 1 GB AWS free-tier EC2 micro) compresses images/videos only, one file at a time, ~10 s per image. TinyPNG does 3 files in ~10 s. A public launch needs (a) many more formats, (b) far better speed, (c) real security hardening, (d) SEO-friendly pages.

**Core idea:** **Browser-first processing.** Run as much as possible on the user's device (WASM codecs + WebCodecs, parallel Web Workers). The EC2 server is only a *fallback* for jobs browsers can't do (Office docs, PDF compression, big/exotic media). This (1) removes the server speed bottleneck, (2) costs nothing per job, (3) gives a privacy pitch: "your files never leave your device" for most tools.

**Owner constraints (from the user):**
- Free-tier EC2 (t2/t3.micro, 1 GB RAM, 1–2 vCPU). Free tier ends after 12 months — user will handle later.
- Wants tests that "try to break the system" at a good level.
- **Token/usage budget is limited — work efficiently** (see §10).
- Deploy target stays EC2 + pm2 via GitHub Actions on push to `main`.

### Goals
1. Tools: compress/convert **images, video, audio, fonts, PDFs, documents (docx etc.), spreadsheets** (16 tools, §4).
2. Speed: **3 typical photos (2–5 MB) → WebP in < 5 s total** on a mid-range laptop, processed in parallel. (Benchmark test asserts < 8 s in the sandbox.)
3. Security: no shell injection, path traversal, XSS, zip/decompression bombs, public leaking of other users' filenames.
4. SEO: one static, crawlable page per tool (title, description, JSON-LD, FAQ).
5. Keep the existing visual identity (dark theme, Inter, profile pills, side-by-side comparison with synced video, progress, quality score).

### Non-goals (now)
User accounts, payments, rate-plan tiers, CDN, Redis/BullMQ, multi-server scaling, mobile apps, OCR, video editing.

PDF editing is now in scope as an interactive, fully client-side page (`/edit-pdf`, `web/src/pages/edit-pdf.astro` + `web/src/scripts/editor/pdf/`). It sits outside the `Engine.run` job model and the tool registry; it is listed next to the PDF tools via `web/src/lib/editors.ts`.

---

## 2. Decisions already made (do not re-litigate)

| Decision | Rationale |
|---|---|
| **Frontend: Astro + TypeScript** (static output, one page per tool) | SEO per tool page; small JS; framework escapes by default. Avoid Next.js SSR (extra Node process on 1 GB box). |
| **Backend: keep Express, convert to TypeScript, split per tool** | Real work is FFmpeg/LibreOffice/Ghostscript regardless of UI stack. |
| **Browser-first engine** (`engine/`, framework-agnostic TS) | Speed + privacy + zero server cost. |
| **Queue stays in-memory** (no Redis) | Micro instance; overkill otherwise. |
| **Remove shared "Team Compression History"** | Public site would leak every visitor's filenames. Replaced by per-user `localStorage` history + server aggregate counts only (`/api/stats`). |
| **`exceljs` (not SheetJS) for browser spreadsheets** | SheetJS CDN is blocked in the sandbox/proxy; exceljs is on npm. |
| **No runtime CDN loads** (fonts, wasm, scripts all self-hosted) | Pages are cross-origin isolated (COOP/COEP) for multithreaded WASM; CDNs break under COEP. |
| **Exact-pinned dependencies** | Reproducible builds. |

---

## 3. Architecture

```
web/      Astro static site (tool pages, workspace UI)        → imports ONLY engine/src/index.ts
engine/   Framework-agnostic TS: registry, routing, worker pool,
          browser processors (WASM/WebCodecs), server client   → talks to server over HTTP when needed
server/   Express+TS fallback API (FFmpeg, sharp, Ghostscript, qpdf, LibreOffice, fontTools)
          serves web/dist; job queue; validation; cleanup
```

Routing per job: **browser** if tool + input formats + options + file size are supported in-browser → else **server** if `/api/capabilities` lists the tool → else error with human-readable reason.

Browser concurrency: `clamp(hardwareConcurrency − 1, 1, 4)`; video 1–2 concurrent. Workers reused (warm codecs). Cancellation via `AbortSignal` (rejects with `name === "AbortError"`, frees the slot).

**Contracts (binding):**
- `engine/src/types.ts` — `ToolDefinition`, `JobInput`, `JobResult`, `Engine`, `OptionField` (UI renders forms generically from `options`; no per-tool hardcoded forms). **Lead-owned: do not edit; if a change is truly needed, stop and say why.**
- `docs/PLAN.md` — ownership map + server HTTP API.

---

## 4. Tool matrix

Registry: `engine/src/tools.ts` (authoritative for slugs, accepts/outputs, option keys/values, runtimes).

| ToolId | Slug | Runtime preference | Notes |
|---|---|---|---|
| image-compress | compress-image | browser → server | `@jsquash/*` in workers; never-larger guarantee |
| image-convert | convert-image | browser → server | HEIC via `heic-to`; GIF/BMP/TIFF via createImageBitmap else server |
| video-compress | compress-video | browser (mediabunny/WebCodecs) → server | profiles: quality-safe / web-stream / av1 / custom |
| video-convert | convert-video | browser → server | mp4/webm/mov/gif |
| video-to-audio | extract-audio | browser → server | |
| audio-convert | convert-audio | browser → server | mp3/wav/flac need ffmpeg.wasm or server |
| audio-compress | compress-audio | browser → server | |
| font-convert | convert-font | browser (woff/woff2) / server (ttf↔otf) | WOFF1 hand-rolled w/ fflate; woff2 via wawoff2 |
| pdf-compress | compress-pdf | **server only** | Ghostscript + qpdf; never return larger than input |
| pdf-merge | merge-pdf | browser (pdf-lib) / server | multiInput |
| pdf-split | split-pdf | browser / server | ranges or every page |
| pdf-to-images | pdf-to-image | browser (pdfjs-dist) | multiple outputs |
| images-to-pdf | images-to-pdf | browser (pdf-lib) | multiInput |
| document-convert | convert-document | **server only** | LibreOffice headless |
| spreadsheet-convert | convert-spreadsheet | browser (xlsx/csv/json) / server (xls/ods/pdf) | exceljs |

Option keys (must match between `engine/src/tools.ts` and `server/src/tools.ts`): image `format, quality, width, height, effort`; video `profile, format, codec, crf, resolution, audioBitrate, stripAudio`; audio `format, bitrate`; font `format`; pdf-compress `level (screen|ebook|printer)`; pdf-split `mode (ranges|every), ranges`; pdf-to-images `format, dpi`; images-to-pdf `pageSize (fit|a4|letter), margin`; document/spreadsheet `format`.

---

## 5. Server HTTP API (fallback runtime)

Defined in `docs/PLAN.md`. Summary: `GET /api/health`, `GET /api/capabilities` (probes binaries; lists only runnable tools), `POST /api/jobs` (multipart `tool`, `options`, `files` → 202 `{jobId}`; 400/413/429), `GET /api/jobs/:id`, `GET /api/jobs/:id/events` (SSE), `GET /api/jobs/:id/outputs/:index`, `DELETE /api/jobs/:id`, `GET /api/stats` (aggregate only).

Required server behaviours: per-job temp dir (UUID job ids), 30-min TTL cleanup + cleanup on cancel/error + startup sweep; two queues (heavy: video/soffice/gs concurrency 1; light: 2), bounded (`MAX_QUEUE`, default 20 → 429); per-tool timeouts and child-process kill (process group for LibreOffice); upload validation by extension allowlist **and magic bytes** (`server/src/sniff.ts` exists); per-IP rate limit; security headers (COOP same-origin, COEP require-corp, CORP, nosniff, strict CSP allowing `'wasm-unsafe-eval'`, workers self+blob:); decompression-bomb guards (sharp `limitInputPixels` ~100 MP, ffprobe pre-check, PDF page cap); S3 upload optional and OFF unless `S3_BUCKET_NAME`; serve `web/dist` (hashed `/_astro/*` long-cache, HTML no-cache, `application/wasm`).

---

## 6. Security requirements

Already fixed on this branch in commit `9111b09` (legacy code) — **must not regress in the new code**:
1. Shell injection: upload extension was concatenated into a shell command (`exec`). Now: extension allowlist `^\.[a-z0-9]{1,10}$`, `execFile` with arg arrays only. **Never build shell strings from user data.**
2. Path traversal on download/preview routes → resolve strictly inside the output dir (`resolveOutputFile`).
3. Stored XSS: filenames/errors/URLs inserted via `innerHTML`. New UI: `textContent`/DOM APIs only, no inline event handlers (CSP).
4. A missing `appendErrorCard` made one failed file abort the whole batch.

Additional requirements: no public per-file history; job ids unguessable; originals sanitized for `Content-Disposition` (RFC 5987); zip-bomb / pixel-bomb / huge-duration guards; no secrets in repo.

---

## 7. Known technical findings (save re-discovery cost)

- Legacy video path: **VP9 with `-b:v 0` plus `-maxrate` fails outright** in FFmpeg → don't combine them.
- **SVT-AV1 cannot run under an address-space limit (`ulimit -v`/RLIMIT_AS) and uses ~800 MB RSS at 1080p.** On the 1 GB box, server AV1 must be capped (≤720p, low-memory params) or refused with a clear message. Don't rely on RLIMIT_AS for AV1.
- Legacy FFmpeg choices to **preserve** for server video/image: quality-safe CRF 18, web-stream 720p CRF 23, BT.709 tagging, `setsar=1`, bitrate ceiling at ~92% of source so output never inflates, 4K+ → 1080p memory guard, SSIM scoring, poster frame.
- Headless Chromium here may lack H.264 WebCodecs; VP8/VP9/AV1 software encoders are usually present. Test what exists; skip-with-reason only for genuinely unavailable codecs.
- EC2 needs a ~2 GB swapfile and `ffmpeg ghostscript qpdf libreoffice-writer/calc/impress python3-fonttools python3-brotli fonts-dejavu fonts-liberation`. LibreOffice + FFmpeg concurrently will OOM a 1 GB box — hence the heavy queue concurrency of 1.
- Vite needs: `server.fs.allow: ['..']`, worker format `'es'`, `optimizeDeps.exclude` for `@jsquash/*`, `@ffmpeg/*`, `wawoff2`, `mediabunny`, `pdfjs-dist`; COOP/COEP headers on dev **and** preview; `/api` proxy → `localhost:3000`.
- Sandbox environment: Node 22, Playwright Chromium at `/opt/pw-browsers` (set `PLAYWRIGHT_BROWSERS_PATH`; **never run `playwright install`**; if versions mismatch use `executablePath` under that dir). Installed: `ffmpeg ffprobe gs qpdf soffice convert(ImageMagick) pdftoppm python3` + `fonttools brotli` (pip). Outbound access to cdn.sheetjs.com is blocked.

---

## 8. Current state (honest snapshot at handoff)

Commits on branch: `9111b09` security fixes → `b39412b` plan+contracts → WIP checkpoints `ae0aa04`, `0f8738a`, `d2cdfc1`. **Nothing is merged to `main`; production is unchanged.** The legacy `server.js`, `public/`, `bun.lock`, `data/history.json` are still in the repo and still what `main` runs.

| Area | State | Verified how |
|---|---|---|
| Security fixes (legacy) | **Done, verified** (traversal → 404, injected extension stripped, normal flow OK) | manual curl against running server |
| `docs/PLAN.md`, `engine/src/types.ts` | Done | — |
| **Engine** `engine/` | **Substantially written**: registry, routing, options, ranges, errors, pool, scheduler, protocol, worker-host/factories, 3 workers (image/media/doc), processors (image encode/decode/probe, ssim, woff, csv, font, pdf, pdf-render, sheet, media, media-plan, ffmpeg-args), `index.ts` (createEngine), `server-client.ts`, `scripts/{copy-assets,make-fixtures}.mjs` | **14 node unit tests pass** (incl. WOFF1 round-trip validated by fontTools). `tsc --noEmit` has **1 known error**: `vitest.config.ts(20)` `fileParallelism` not allowed in a project config (move to top-level `test`). **No browser (Chromium) tests have been run. The speed benchmark has NOT been run — the < 5 s claim is unverified.** |
| **Server** `server/` | **Early**: `config, errors, log, probe, proc, sniff, tools, util`, `scripts/font_convert.py`, tsconfigs, vitest config. **No `index.ts`/app, queue, routes, processors wiring, Dockerfile/workflow update, or tests** (`server/test/` empty). `tsc` has 2 errors: `src/tools.ts` can't resolve `@contracts/types` (fix path alias in tsconfig) and `ServerTool | undefined` at line ~246. Root `package.json`/lockfile modified (express 5.2.1, sharp 0.34.5, ts 5.9.3, vitest 4.0.18, supertest). | typecheck only |
| **Web** `web/` | **Mostly written**: Astro 7.4.0 config, layout, global.css, pages (`index`, `[slug]`, `tools/[category]`, `privacy`, `404`, `robots.txt`), `Workspace.astro`, `CategoryGrid.astro`, workspace scripts (`main, files, queue-view, results-view, history-view, modals, media, types`), `lib/*` (form, registry, content, history, zip, engine wrapper + engine-mock), stats script, 2 Playwright specs (`pages.spec.ts`, `form.spec.ts`) | A `dist-test/` build exists (all 15 tool pages + category pages + sitemap generated). **Playwright results unknown; workspace not confirmed wired to the real engine (check `web/src/lib/engine.ts`).** |
| End-to-end / adversarial test suite | **Not started** | — |
| Dockerfile / deploy workflow | **Unchanged (still legacy)** | — |

Generated artifacts are gitignored (`engine/test/{fixtures,.public,.out}`, `web/{dist,dist-test,.astro,test-results}`, `node_modules`). Verify with `git add -A --dry-run | grep -E "node_modules|dist|vendor"` before committing.

---

## 9. Remaining work — in priority order

Do these **sequentially, one agent at a time** (parallel agents exhausted the user's limit). Each package has acceptance criteria; stop and report at the first one you can't meet.

### P1 — Engine: make it work and prove the speed claim *(highest value)*
1. Fix `engine/vitest.config.ts` typecheck error; `npx tsc --noEmit` clean.
2. Run the browser project in real Chromium. Get the image path green: compress/convert PNG/JPEG/WebP/AVIF, EXIF orientation, alpha preserved, never-larger guarantee (`meta.keptOriginal`), corrupt/truncated/zero-byte → clear error (no hang), huge dimensions rejected gracefully.
3. **Benchmark**: 3 × ~3 MB photos (4000×3000 noisy-gradient JPEGs from `make-fixtures.mjs`) → WebP q80 in parallel; print timing; assert < 8 s here. Report the number honestly. If it misses, profile (worker warm-up, decode path, resize, wasm threading) before moving on.
4. Cancel mid-job frees the pool slot; 10 simultaneous jobs → bounded concurrency, all finish; progress monotonic → 100.
5. Registry integrity test (every ToolId once, unique slugs, defaults valid, `showIf` refs exist); routing test (server-only tools route to server; null + reason when server lacks them).
6. PDF merge/split/images-to-pdf/pdf-to-images, font woff/woff2, spreadsheet xlsx↔csv/json: valid-output tests (verify bytes with qpdf/fontTools node-side where possible).
7. Video/audio via mediabunny: test available codecs only; ffmpeg.wasm fallback for mp3/wav/flac/GIF.
**Done when:** unit + browser suites green, benchmark number reported, typecheck clean.

### P2 — Server: finish the fallback API
Build `server/src/index.ts` + routes exactly per §5 / `docs/PLAN.md`; wire `server/src/tools.ts` processors (sharp/FFmpeg preserving legacy profiles, Ghostscript+qpdf, soffice with per-job `-env:UserInstallation`, fontTools script); fix the 2 tsc errors; options validated by allowlist matching `engine/src/tools.ts`; capabilities probing. Then: root scripts (`build`, `build:server`, `start` = `node --max-old-space-size=384 server/dist/index.js`, `test`, `typecheck`), multi-stage `Dockerfile`, `.github/workflows/deploy.yml` (test job on PR + main, then `npm ci && npm run build`, pm2 restart), `server/README-deploy.md` (apt list + swapfile). Delete legacy `server.js`, `public/`, `bun.lock`, tracked `data/history.json` **only when the new server serves the new site and its tests pass**.
**Tests (supertest + real binaries, fixtures generated in setup):** each tool happy path verified with ffprobe/sharp/`qpdf --check`/fontTools; traversal on every param route (encoded, double-encoded, backslash, null byte); shell metacharacters + unicode/RTL/very long filenames; extension↔magic mismatch (PNG named .pdf, HTML named .docx, non-docx zip); empty/truncated/corrupt files; oversize → 413; too many files; unknown tool/option/extra keys/wrong types → 400; pixel-bomb PNG rejected fast; queue full → 429; **cancel kills the child process** (assert none left); 10 parallel image jobs → distinct valid outputs; random uuid → 404; outputs gone after cleanup; SSE terminates; pdf-compress never larger; security headers present. Suite < ~3 min; mark LibreOffice tests heavy.
**Done when:** `npm run typecheck && npm test` green; `npm run build` produces a working server that serves `web/dist`.

### P3 — Web: finish and wire
Confirm `web/src/lib/engine.ts` uses the real engine (mock only for deterministic tests). Finish workspace behaviours: generic option form (select/range/number/toggle/text + `showIf`; video `profile` as pills), drag/drop/click/paste, multi-file queue with retry/remove, multiInput reorder, results (sizes, savings, runtime badge "On your device"/"On our server", time, quality score, side-by-side image/video/audio with synced playback + fullscreen modal), ZIP download-all, cancel per job/all, `beforeunload` guard, localStorage history (cap 50, try/catch), stats badge (graceful offline), clear "unavailable" message for server-only tools when offline. `astro check` + `astro build` clean; report tool-page JS bundle sizes.
**Playwright (against `astro build` + `astro preview` on 4321):** every tool page renders correct title/H1/meta/JSON-LD with no console errors; filenames like `<img src=x onerror=alert(1)>.png` render as text (no dialog/no injected node); 25 files at once; unsupported types rejected visibly; cancel mid-job; localStorage throwing; server offline; 360 px viewport no horizontal scroll; keyboard-only flow; plus a few **real-engine** E2E tests (PNG → WebP, verify magic bytes of the downloaded file).
**Done when:** check + build + Playwright green.

### P4 — Cross-cutting E2E + launch readiness
Full-stack tests (real server + real built site): upload via UI to a server-only tool (docx → pdf), cancel, concurrency, error banners. Load sanity on the 1 GB profile (`MAX_QUEUE`, memory under heavy jobs; document the swap recipe). SEO checks (sitemap, canonical, robots). Write `README.md` for the new layout. Final security pass (`/security-review`).

### P5 — Release (needs the user's explicit go-ahead)
Merge to `main` only when the user says so (auto-deploys to EC2). Confirm GitHub secrets (`EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`) and the new EC2 package/swap steps are done first; do a manual staging run on the box if possible.

---

## 10. Working rules for any agent on this repo

**Efficiency (the user's limit is tight):**
- One agent at a time. Don't re-read files you wrote; read the specific part you need. Pipe noisy output through `| tail -20`.
- Write focused tests that match the acceptance lists above — don't invent exhaustive suites.
- Prefer one commit per finished work package; keep final reports under ~300 words.

**Ownership** (if multiple agents ever run again): lead owns `docs/`, `engine/src/types.ts`; engine agent `engine/` + `web/public/vendor/`; server agent `server/`, root `package.json`, `Dockerfile`, `.github/`; UI agent `web/`; QA agent `tests/`.

**Code rules:** exact-pinned deps; no CDN at runtime; `execFile`/`spawn` with arg arrays only; no `innerHTML` with user strings; no inline event handlers; tests use real files and real codecs (no mocking the thing under test); server tests use ephemeral ports (`listen(0)`); Astro dev port 4321; match surrounding code style.

**Git rules:** develop only on `claude/exciting-brahmagupta-bskdm1`; push with `git push -u origin <branch>` (retry up to 4× with 2/4/8/16 s backoff on network errors only); **do not create a PR unless the user asks**; never `git add -A` blind — check the dry-run for `node_modules`/`dist`/`vendor`/large binaries first; end commit messages with the attribution lines from the session's system reminder. A stop-hook asks for commit+push whenever the tree is dirty — commit a checkpoint rather than leaving work uncommitted.

**Reporting:** be exact. State what you ran and the real result (counts, timings, skips with reasons). Don't claim unverified behaviour — the < 5 s speed target in particular is unproven until P1 step 3 prints a number.

---

## 11. Kickoff prompt for a fresh agent (paste as-is)

> You are continuing a rebuild of a media compressor/converter in `/home/user/media-compressor` on branch `claude/exciting-brahmagupta-bskdm1`. Read `docs/PRD.md` fully, then `docs/PLAN.md`, `engine/src/types.ts`, and skim `engine/src/tools.ts`. Work through §9 **strictly in order, starting at P1**, one package at a time. Be token-efficient (§10). After each package: run its tests, commit a checkpoint (check `git add -A --dry-run` first), push to the branch, and report in under 300 words what passed, what failed, and real timings. Do not open a PR or touch `main`. Stop and ask if a contract in `engine/src/types.ts` needs to change.
