/**
 * Pure routing logic: decides browser vs server for a job. No DOM access — the environment is
 * passed in, so this is unit-testable in node.
 */
import type { Options, Runtime, ToolDefinition, ToolId } from "./types";
import { extOf, fontFlavor, formatBytes, sniff } from "./formats";

export const MB = 1024 * 1024;
/** ffmpeg.wasm keeps input + output in WASM memory (≤ 2–4 GB address space) → cap inputs. */
export const FFMPEG_MAX_BYTES = 200 * MB;
/** Max decoded pixels for an in-browser image (RGBA 100 MP ≈ 400 MB per buffer). */
export const MAX_IMAGE_PIXELS = 100_000_000;

export const BROWSER_IMAGE_INPUTS = new Set(["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "heic", "heif"]);
/** Containers/codecs mediabunny (WebCodecs) can't demux/decode → ffmpeg.wasm. */
export const FFMPEG_ONLY_MEDIA_INPUTS = new Set(["avi", "ogv", "3gp"]);
export const BROWSER_SHEET_FORMATS = new Set(["xlsx", "csv", "json"]);

export interface BrowserEnv {
  /** VideoEncoder/VideoDecoder/AudioEncoder/AudioDecoder present. */
  webCodecs: boolean;
  wasm: boolean;
  workers: boolean;
  offscreenCanvas: boolean;
  crossOriginIsolated: boolean;
}

export interface ServerEnv {
  tools: ToolId[];
  maxFileBytes?: number;
  maxFiles?: number;
}

export interface FileInfo {
  name: string;
  size: number;
  /** First bytes of the file (≥ 16), for magic-byte checks. */
  head?: Uint8Array;
}

export type PlanResult = { runtime: Runtime } | { runtime: null; reason: string };

type Support = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Support => ({ ok: false, reason });
const yes: Support = { ok: true };

export type MediaPath = "mediabunny" | "ffmpeg";

/** Which in-browser media engine handles this job (or a reason it can't run in-browser). */
export function mediaPath(
  toolId: ToolId,
  inputExt: string,
  options: Options,
  env: Pick<BrowserEnv, "webCodecs" | "wasm">,
): MediaPath | { reason: string } {
  const needsFfmpeg =
    (toolId === "video-convert" && options.format === "gif") || FFMPEG_ONLY_MEDIA_INPUTS.has(inputExt) || !env.webCodecs;
  if (needsFfmpeg) {
    if (!env.wasm) return { reason: "This browser lacks WebAssembly support needed for this conversion." };
    return "ffmpeg";
  }
  return "mediabunny";
}

function browserSupport(tool: ToolDefinition, files: FileInfo[], options: Options, env: BrowserEnv): Support {
  if (!tool.runtimes.includes("browser")) return no(`${tool.title.split(" — ")[0]} needs our server.`);
  if (!env.workers || !env.wasm) return no("This browser lacks Web Workers/WebAssembly.");
  const max = tool.browserMaxBytes ?? Infinity;
  for (const f of files) {
    if (f.size > max) return no(`${f.name} is too large to process in the browser (max ${formatBytes(max)}).`);
  }
  const exts = files.map((f) => extOf(f.name));
  switch (tool.category) {
    case "image": {
      if (!env.offscreenCanvas) return no("This browser lacks OffscreenCanvas.");
      const bad = exts.find((e) => !BROWSER_IMAGE_INPUTS.has(e));
      if (bad !== undefined) return no(`.${bad || "?"} images can't be decoded in the browser.`);
      return yes;
    }
    case "video":
    case "audio": {
      // mediabunny (WebCodecs) or ffmpeg.wasm; the media processor throws "browser-unsupported" (→ server) for the rest.
      const path = mediaPath(tool.id, exts[0] ?? "", options, { webCodecs: env.webCodecs, wasm: env.wasm });
      if (typeof path === "object") return no(path.reason);
      if (path === "ffmpeg" && files.some((f) => f.size > FFMPEG_MAX_BYTES)) return no(`The in-browser fallback encoder handles files up to ${formatBytes(FFMPEG_MAX_BYTES)}.`);
      return yes;
    }
    case "font": {
      const target = String(options.format ?? "woff2");
      for (const f of files) {
        if (!f.head) continue; // unknown → let the processor validate
        const flavor = fontFlavor(f.head);
        if (!flavor) return no(`${f.name} is not a TrueType/OpenType/WOFF font we can read in the browser.`);
        if (target === "ttf" && flavor === "cff") return no("Converting OpenType (CFF) outlines to TrueType needs our server.");
        if (target === "otf" && flavor === "truetype") return no("Converting TrueType outlines to OpenType (CFF) needs our server.");
      }
      return yes;
    }
    case "pdf": {
      if (tool.id === "images-to-pdf") {
        if (!env.offscreenCanvas) return no("This browser lacks OffscreenCanvas.");
        const bad = exts.find((e) => !BROWSER_IMAGE_INPUTS.has(e));
        if (bad !== undefined) return no(`.${bad || "?"} images can't be decoded in the browser.`);
      }
      if (tool.id === "pdf-to-images" && !env.offscreenCanvas) return no("This browser lacks OffscreenCanvas.");
      return yes;
    }
    case "spreadsheet": {
      const target = String(options.format ?? "csv");
      if (!BROWSER_SHEET_FORMATS.has(target)) return no(`Converting to ${target.toUpperCase()} needs our server.`);
      const bad = exts.find((e) => !BROWSER_SHEET_FORMATS.has(e));
      if (bad !== undefined) return no(`Reading .${bad} spreadsheets needs our server.`);
      return yes;
    }
    default:
      return no(`${tool.title.split(" — ")[0]} needs our server.`);
  }
}

function serverSupport(tool: ToolDefinition, files: FileInfo[], server: ServerEnv | null): Support {
  if (!tool.runtimes.includes("server")) return no("This tool doesn't run on the server.");
  if (!server) return no("our server is unreachable right now");
  if (!server.tools.includes(tool.id)) return no("our server doesn't currently offer this tool");
  if (server.maxFiles !== undefined && files.length > server.maxFiles) {
    return no(`the server accepts at most ${server.maxFiles} files per job`);
  }
  if (server.maxFileBytes !== undefined) {
    const big = files.find((f) => f.size > server.maxFileBytes!);
    if (big) return no(`${big.name} exceeds the server limit of ${formatBytes(server.maxFileBytes)}`);
  }
  return yes;
}

/** Validates the input shape (file count, extensions, zero-byte). Returns a reason or null. */
export function validateInput(tool: ToolDefinition, files: FileInfo[]): string | null {
  if (files.length === 0) return "No file selected.";
  if (!tool.multiInput && files.length > 1) return `${tool.title.split(" — ")[0]} takes one file at a time.`;
  for (const f of files) {
    if (f.size === 0) return `${f.name} is empty (0 bytes).`;
    const ext = extOf(f.name);
    if (!tool.accepts.includes(ext)) {
      // Allow a mislabeled/missing extension if magic bytes say it's acceptable.
      const sniffed = f.head ? sniff(f.head) : null;
      const okBySniff = sniffed !== null && (tool.accepts.includes(sniffed) || (sniffed === "jpg" && tool.accepts.includes("jpeg")));
      if (!okBySniff) return `${f.name}: .${ext || "(no extension)"} files aren't supported by this tool.`;
    }
  }
  return null;
}

export function planJob(
  tool: ToolDefinition,
  files: FileInfo[],
  options: Options,
  browser: BrowserEnv,
  server: ServerEnv | null,
  preferRuntime?: Runtime,
): PlanResult {
  const invalid = validateInput(tool, files);
  if (invalid) return { runtime: null, reason: invalid };
  const b = browserSupport(tool, files, options, browser);
  const s = serverSupport(tool, files, server);
  if (preferRuntime === "browser") return b.ok ? { runtime: "browser" } : { runtime: null, reason: b.reason };
  if (preferRuntime === "server") {
    return s.ok ? { runtime: "server" } : { runtime: null, reason: `Can't run on the server: ${s.reason}.` };
  }
  for (const rt of tool.runtimes) {
    if (rt === "browser" && b.ok) return { runtime: "browser" };
    if (rt === "server" && s.ok) return { runtime: "server" };
  }
  if (!tool.runtimes.includes("browser")) {
    return { runtime: null, reason: `This tool runs on our server, but ${s.ok ? "" : s.reason}. Please try again later.` };
  }
  const bReason = b.ok ? "" : b.reason;
  if (!tool.runtimes.includes("server")) return { runtime: null, reason: bReason };
  return { runtime: null, reason: `${bReason} The server fallback isn't available: ${s.ok ? "" : s.reason}.` };
}
