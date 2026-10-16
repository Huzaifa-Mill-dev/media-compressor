/**
 * Server-side tool table: accepted extensions, option allowlists, queue class, timeouts and binary
 * requirements. Tool ids, option keys and allowed values MUST match `engine/src/tools.ts` — a test
 * (server/test/registry.test.ts) compares the two so they cannot drift.
 */
import type { ToolId } from "@contracts/types";
import type { Binaries } from "./probe.js";
import { badRequest } from "./errors.js";

export type OptionSpec =
  | { t: "select"; values: readonly string[]; def: string }
  | { t: "range"; min: number; max: number; def: number }
  | { t: "number"; min: number; max: number } // optional integer, no default
  | { t: "toggle"; def: boolean }
  | { t: "text"; max: number; def: string; pattern?: RegExp };

export type OptionValue = string | number | boolean | undefined;
export type ResolvedOptions = Record<string, OptionValue>;

type Need = keyof Pick<Binaries, "ffmpeg" | "ffprobe" | "gs" | "qpdf" | "soffice" | "fonttools">;

export interface ServerTool {
  id: ToolId;
  /** "heavy" = single-slot queue (video, LibreOffice, Ghostscript); "light" = two slots. */
  queue: "heavy" | "light";
  accepts: readonly string[];
  multiInput: boolean;
  options: Record<string, OptionSpec>;
  needs: readonly Need[];
  /** Wall-clock limit before the job (and its child processes) are killed. */
  timeoutMs: number;
}

const MIN = 60_000;

const IMAGE_INPUTS = ["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "heic", "heif", "tif", "tiff"] as const;
const VIDEO_INPUTS = ["mp4", "m4v", "mov", "webm", "mkv", "avi", "ogv", "3gp"] as const;
const AUDIO_INPUTS = ["mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "weba"] as const;
const FONT_INPUTS = ["ttf", "otf", "woff", "woff2"] as const;
const DOC_INPUTS = ["doc", "docx", "odt", "rtf", "txt", "html", "htm", "ppt", "pptx", "odp"] as const;
/** The registry also lists `json` (browser-only); LibreOffice cannot read or write it. */
const SHEET_INPUTS = ["xlsx", "xls", "ods", "csv"] as const;

export const PRESENTATION_EXTS: readonly string[] = ["ppt", "pptx", "odp"];
export const SPREADSHEET_EXTS: readonly string[] = [...SHEET_INPUTS];

const imageSize = (): Record<string, OptionSpec> => ({
  width: { t: "number", min: 1, max: 16384 },
  height: { t: "number", min: 1, max: 16384 },
  effort: { t: "select", values: ["fast", "balanced", "best"], def: "balanced" },
});

const BITRATES = ["64k", "96k", "128k", "160k", "192k", "256k", "320k"] as const;
const RESOLUTIONS = ["original", "1440p", "1080p", "720p", "480p"] as const;
const AUDIO_FORMATS = ["mp3", "m4a", "ogg", "opus", "wav", "flac"] as const;

export const SERVER_TOOLS: Record<ToolId, ServerTool> = {
  "image-compress": {
    id: "image-compress",
    queue: "light",
    accepts: IMAGE_INPUTS,
    multiInput: false,
    needs: [],
    timeoutMs: 2 * MIN,
    options: {
      format: { t: "select", values: ["original", "webp", "avif", "jpeg", "png"], def: "original" },
      quality: { t: "range", min: 1, max: 100, def: 75 },
      ...imageSize(),
    },
  },
  "image-convert": {
    id: "image-convert",
    queue: "light",
    accepts: IMAGE_INPUTS,
    multiInput: false,
    needs: [],
    timeoutMs: 2 * MIN,
    options: {
      format: { t: "select", values: ["webp", "avif", "jpeg", "png"], def: "webp" },
      quality: { t: "range", min: 1, max: 100, def: 85 },
      ...imageSize(),
    },
  },
  "video-compress": {
    id: "video-compress",
    queue: "heavy",
    accepts: VIDEO_INPUTS,
    multiInput: false,
    needs: ["ffmpeg", "ffprobe"],
    timeoutMs: 60 * MIN,
    options: {
      profile: { t: "select", values: ["quality-safe", "web-stream", "av1", "custom"], def: "quality-safe" },
      format: { t: "select", values: ["mp4", "webm"], def: "mp4" },
      codec: { t: "select", values: ["h264", "h265", "vp9", "av1"], def: "h264" },
      crf: { t: "range", min: 14, max: 40, def: 23 },
      resolution: { t: "select", values: RESOLUTIONS, def: "original" },
      audioBitrate: { t: "select", values: BITRATES.filter((b) => parseInt(b, 10) <= 256), def: "128k" },
      stripAudio: { t: "toggle", def: false },
    },
  },
  "video-convert": {
    id: "video-convert",
    queue: "heavy",
    accepts: VIDEO_INPUTS,
    multiInput: false,
    needs: ["ffmpeg", "ffprobe"],
    timeoutMs: 60 * MIN,
    options: {
      format: { t: "select", values: ["mp4", "webm", "mov", "mkv", "gif"], def: "mp4" },
      resolution: { t: "select", values: RESOLUTIONS, def: "original" },
      stripAudio: { t: "toggle", def: false },
    },
  },
  "video-to-audio": {
    id: "video-to-audio",
    queue: "heavy",
    accepts: VIDEO_INPUTS,
    multiInput: false,
    needs: ["ffmpeg", "ffprobe"],
    timeoutMs: 20 * MIN,
    options: {
      format: { t: "select", values: AUDIO_FORMATS, def: "mp3" },
      bitrate: { t: "select", values: BITRATES, def: "192k" },
    },
  },
  "audio-convert": {
    id: "audio-convert",
    queue: "light",
    accepts: AUDIO_INPUTS,
    multiInput: false,
    needs: ["ffmpeg", "ffprobe"],
    timeoutMs: 10 * MIN,
    options: {
      format: { t: "select", values: AUDIO_FORMATS, def: "mp3" },
      bitrate: { t: "select", values: BITRATES, def: "192k" },
    },
  },
  "audio-compress": {
    id: "audio-compress",
    queue: "light",
    accepts: AUDIO_INPUTS,
    multiInput: false,
    needs: ["ffmpeg", "ffprobe"],
    timeoutMs: 10 * MIN,
    options: {
      format: { t: "select", values: ["mp3", "m4a", "ogg", "opus"], def: "mp3" },
      bitrate: { t: "select", values: BITRATES, def: "96k" },
    },
  },
  "font-convert": {
    id: "font-convert",
    queue: "light",
    accepts: FONT_INPUTS,
    multiInput: false,
    needs: ["fonttools"],
    timeoutMs: MIN,
    options: { format: { t: "select", values: ["woff2", "woff", "ttf", "otf"], def: "woff2" } },
  },
  "pdf-compress": {
    id: "pdf-compress",
    queue: "heavy",
    accepts: ["pdf"],
    multiInput: false,
    needs: ["gs", "qpdf"],
    timeoutMs: 8 * MIN,
    options: { level: { t: "select", values: ["screen", "ebook", "printer"], def: "ebook" } },
  },
  "pdf-merge": {
    id: "pdf-merge",
    queue: "light",
    accepts: ["pdf"],
    multiInput: true,
    needs: ["qpdf"],
    timeoutMs: 3 * MIN,
    options: {},
  },
  "pdf-split": {
    id: "pdf-split",
    queue: "light",
    accepts: ["pdf"],
    multiInput: false,
    needs: ["qpdf"],
    timeoutMs: 3 * MIN,
    options: {
      mode: { t: "select", values: ["every", "ranges"], def: "every" },
      ranges: { t: "text", max: 1000, def: "", pattern: /^[0-9a-zA-Z,;\s\-–$]*$/ },
    },
  },
  "pdf-to-images": {
    id: "pdf-to-images",
    queue: "heavy",
    accepts: ["pdf"],
    multiInput: false,
    needs: ["gs", "qpdf"],
    timeoutMs: 8 * MIN,
    options: {
      format: { t: "select", values: ["png", "jpeg"], def: "png" },
      dpi: { t: "range", min: 72, max: 300, def: 150 },
    },
  },
  "images-to-pdf": {
    id: "images-to-pdf",
    queue: "light",
    accepts: ["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "heic", "heif"],
    multiInput: true,
    needs: [],
    timeoutMs: 5 * MIN,
    options: {
      pageSize: { t: "select", values: ["fit", "a4", "letter"], def: "fit" },
      margin: { t: "range", min: 0, max: 50, def: 0 },
    },
  },
  "document-convert": {
    id: "document-convert",
    queue: "heavy",
    accepts: DOC_INPUTS,
    multiInput: false,
    needs: ["soffice"],
    timeoutMs: 4 * MIN,
    options: { format: { t: "select", values: ["pdf", "docx", "odt", "rtf", "txt", "html"], def: "pdf" } },
  },
  "spreadsheet-convert": {
    id: "spreadsheet-convert",
    queue: "heavy",
    accepts: SHEET_INPUTS,
    multiInput: false,
    needs: ["soffice"],
    timeoutMs: 4 * MIN,
    options: {
      // `json` is in the engine registry (browser-only); LibreOffice cannot produce it → rejected below.
      format: { t: "select", values: ["csv", "xlsx", "json", "ods", "pdf"], def: "csv" },
      sheets: { t: "select", values: ["first", "all"], def: "first" },
    },
  },
};

export function isToolId(v: unknown): v is ToolId {
  return typeof v === "string" && Object.hasOwn(SERVER_TOOLS, v);
}

export function toolAvailable(tool: ServerTool, bins: Binaries): boolean {
  // Fail closed: never run LibreOffice on untrusted documents without network isolation.
  if (tool.needs.includes("soffice") && !bins.officeSafe) return false;
  return tool.needs.every((n) => bins[n]);
}

export function availableTools(bins: Binaries): ToolId[] {
  return (Object.keys(SERVER_TOOLS) as ToolId[]).filter((id) => toolAvailable(SERVER_TOOLS[id]!, bins));
}

/** Validate `options` against the tool's allowlist and fill defaults. Throws HttpError(400). */
export function resolveOptions(tool: ServerTool, raw: unknown): ResolvedOptions {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw badRequest("options must be a JSON object");
  const input = raw as Record<string, unknown>;
  const spec = tool.options;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(spec, key)) throw badRequest(`Unknown option "${key.slice(0, 40)}" for ${tool.id}`);
  }
  const out: ResolvedOptions = {};
  for (const [key, s] of Object.entries(spec)) {
    const has = Object.hasOwn(input, key);
    const v = has ? input[key] : undefined;
    switch (s.t) {
      case "select":
        if (!has) out[key] = s.def;
        else if (typeof v !== "string" || !s.values.includes(v)) {
          throw badRequest(`Invalid value for option "${key}" (allowed: ${s.values.join(", ")})`);
        } else out[key] = v;
        break;
      case "range":
        if (!has) out[key] = s.def;
        else out[key] = checkInt(key, v, s.min, s.max);
        break;
      case "number":
        if (!has || v === "") out[key] = undefined; // optional; "" = not set (registry convention)
        else out[key] = checkInt(key, v, s.min, s.max);
        break;
      case "toggle":
        if (!has) out[key] = s.def;
        else if (typeof v !== "boolean") throw badRequest(`Option "${key}" must be true or false`);
        else out[key] = v;
        break;
      case "text":
        if (!has) out[key] = s.def;
        else if (typeof v !== "string") throw badRequest(`Option "${key}" must be a string`);
        else if (v.length > s.max) throw badRequest(`Option "${key}" is too long`);
        else if (s.pattern && !s.pattern.test(v)) throw badRequest(`Option "${key}" contains unsupported characters`);
        else out[key] = v;
        break;
    }
  }
  return out;
}

function checkInt(key: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) throw badRequest(`Option "${key}" must be an integer`);
  if (v < min || v > max) throw badRequest(`Option "${key}" must be between ${min} and ${max}`);
  return v;
}

/** Cross-field rules that need the file names / other options. Throws HttpError(400). */
export function crossValidate(tool: ServerTool, opts: ResolvedOptions, exts: string[]): void {
  if (tool.id === "document-convert") {
    if (exts.some((e) => PRESENTATION_EXTS.includes(e)) && opts.format !== "pdf") {
      throw badRequest("Presentations (PPT, PPTX, ODP) can only be converted to PDF");
    }
  }
  if (tool.id === "spreadsheet-convert" && opts.format === "json") {
    throw badRequest("JSON output is not available on the server (it runs in the browser)");
  }
  if (tool.id === "pdf-split" && opts.mode === "ranges" && !String(opts.ranges ?? "").trim()) {
    throw badRequest("Enter at least one page or range, e.g. 1-3, 5");
  }
}
