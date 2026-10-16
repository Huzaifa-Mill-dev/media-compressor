# Media Toolkit

A free, public alternative to paywalled converter/compressor sites. Drop files, pick options, get compressed or converted files back. No account, no paywall.

**Browser-first:** most jobs run on the visitor's device (WASM codecs, WebCodecs, parallel Web Workers), so files never leave the machine and the server costs nothing per job. A small Express server is only a *fallback* for what browsers can't do (Office documents, PDF compression, large or exotic media).

| | Tools |
|---|---|
| Images | compress, convert (JPG/PNG/WebP/AVIF/HEIC…), images → PDF |
| Video / audio | compress, convert, extract audio, compress audio |
| PDF | compress (server), merge, split, PDF → images |
| Documents | DOC/DOCX/ODT/RTF/PPT… → PDF and more (server) |
| Spreadsheets | XLSX ↔ CSV/JSON in the browser, XLS/ODS/PDF on the server |
| Fonts | TTF/OTF ↔ WOFF/WOFF2 |

The registry of tools, accepted formats and option keys lives in [`engine/src/tools.ts`](engine/src/tools.ts).

## Layout

```
engine/   Framework-agnostic TypeScript: tool registry, routing, worker pool, browser processors, server client
web/      Astro static site: one crawlable page per tool, workspace UI (imports only engine/src/index.ts)
server/   Express + TypeScript fallback API: FFmpeg, sharp, Ghostscript, qpdf, LibreOffice, fontTools; serves web/dist
docs/     PRD.md (product + decisions) and PLAN.md (contracts, server HTTP API)
```

Routing per job: **browser** if the tool, formats, options and file size are supported there → else **server** if `/api/capabilities` lists the tool → else a readable error.

## Quick start

Requires Node 22. For the server's real-binary tools install `ffmpeg ghostscript qpdf libreoffice python3-fonttools python3-brotli` (see [`server/README-deploy.md`](server/README-deploy.md)); without them those tools are simply not offered.

```bash
npm ci && npm --prefix engine ci && npm --prefix web ci
npm run build          # web/dist + server/dist
npm start              # http://localhost:3000
```

Frontend development: `npm --prefix web run dev` (Astro on :4321, proxies `/api` to :3000).

## Tests

| Command | What it covers |
|---|---|
| `npm run typecheck` | server + contracts (`npm --prefix engine run typecheck` for the engine) |
| `npm test` | server: API/security (traversal, hostile names, magic bytes, limits, rate limit), registry drift vs engine, real-binary tool tests, burst load |
| `npm --prefix engine run test:unit` | pure logic: routing, options, scheduler, WOFF, CSV |
| `npm --prefix engine run test:browser` | real codecs in Chromium + the image speed benchmark |
| `npm --prefix web test` | tool pages, forms, workspace behaviour, SEO invariants, real-engine E2E |
| `npm --prefix web run test:e2e` | real server + production build, server-only tools through the UI (run `npm run build` first) |

Tests that need a binary skip themselves when it is missing; CI installs everything and runs the whole matrix on every push.

## Security model

- Uploads are validated by extension allowlist **and** magic bytes; ZIP-based Office files are checked for zip bombs; images by pixel count, media by duration/frame size, PDFs by page count.
- Child processes are only spawned with argument arrays (never a shell), in their own process group with a timeout and memory guard; cancel kills the whole group.
- Job ids are random UUIDs; files are reachable only through them and are deleted 30 minutes after completion (and on cancel/error and at startup).
- No shared history: the server exposes aggregate counters only; per-user history lives in `localStorage`.
- Strict CSP (no inline scripts), COOP/COEP for multithreaded WASM, `nosniff`, sanitized `Content-Disposition`.

## Deploying

Pushes to `main` run the tests and then deploy to EC2 over SSH (`.github/workflows/deploy.yml`). Box setup, swap, memory budget and environment variables are in [`server/README-deploy.md`](server/README-deploy.md).

## Not implemented yet

In-browser video/audio processing (those jobs currently use the server), server-side video poster frames and SSIM scores, optional S3 upload.
