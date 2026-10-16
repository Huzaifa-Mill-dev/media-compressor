/**
 * Deterministic fake engine used ONLY by UI tests (enabled with the build-time flag
 * PUBLIC_TEST_HOOKS=1 plus `window.__MT_MOCK__` set by the test). It implements the
 * same `Engine` contract as the real engine so the UI can be exercised without codecs.
 *
 * Behaviour knobs (all optional) on `window.__MT_MOCK__`:
 *   stepMs        – delay between progress ticks (default 40)
 *   steps         – number of progress ticks (default 5)
 *   failPattern   – filenames matching this regex reject with an Error
 *   serverTools   – tool ids the "server" can run (default: none → server offline)
 *   outputs       – number of outputs per job (default 1, pdf-split/pdf-to-images 3)
 *   qualityScore  – meta.qualityScore to report
 *   runtime       – force reported runtime
 */
import type {
  Capabilities,
  Engine,
  JobInput,
  JobOutput,
  JobResult,
  Options,
  OptionField,
  RunHandlers,
  Runtime,
  ToolDefinition,
  ToolId,
} from "../../../engine/src/types.ts";

export interface MockConfig {
  stepMs?: number;
  steps?: number;
  failPattern?: string;
  serverTools?: ToolId[];
  outputs?: number;
  qualityScore?: number;
  runtime?: Runtime;
}

const quality: OptionField = { type: "range", key: "quality", label: "Quality", min: 1, max: 100, default: 80 };

/** A registry covering every ToolId and every OptionField type (incl. showIf). */
export const mockTools: ToolDefinition[] = [
  {
    id: "image-compress",
    category: "image",
    slug: "compress-image",
    title: "Compress Image",
    description: "Shrink PNG, JPEG, WebP and AVIF images right in your browser.",
    accepts: ["png", "jpg", "jpeg", "webp", "avif", "gif"],
    outputs: ["webp", "avif", "jpeg", "png"],
    multiInput: false,
    runtimes: ["browser", "server"],
    browserMaxBytes: 50 * 1024 * 1024,
    options: [
      {
        type: "select",
        key: "format",
        label: "Output format",
        default: "webp",
        choices: [
          { value: "webp", label: "WebP" },
          { value: "avif", label: "AVIF" },
          { value: "jpeg", label: "JPEG" },
          { value: "png", label: "PNG" },
        ],
      },
      { ...quality, showIf: { key: "format", equals: ["webp", "avif", "jpeg"] } } as OptionField,
      { type: "toggle", key: "lossless", label: "Lossless", default: false, help: "Bigger files, perfect pixels." },
      { type: "number", key: "maxWidth", label: "Max width", min: 1, max: 16384, placeholder: "e.g. 1920" },
      { type: "text", key: "suffix", label: "Filename suffix", placeholder: "-min", default: "" },
    ],
  },
  {
    id: "image-convert",
    category: "image",
    slug: "convert-image",
    title: "Convert Image",
    description: "Convert images between PNG, JPEG, WebP and AVIF.",
    accepts: ["png", "jpg", "jpeg", "webp", "avif", "gif", "bmp", "heic"],
    outputs: ["png", "jpeg", "webp", "avif"],
    multiInput: false,
    runtimes: ["browser"],
    options: [
      {
        type: "select",
        key: "format",
        label: "Convert to",
        default: "png",
        choices: [
          { value: "png", label: "PNG" },
          { value: "jpeg", label: "JPEG" },
          { value: "webp", label: "WebP" },
        ],
      },
    ],
  },
  {
    id: "video-compress",
    category: "video",
    slug: "compress-video",
    title: "Compress Video",
    description: "Make MP4, MOV and WebM videos smaller without visible quality loss.",
    accepts: ["mp4", "mov", "webm", "mkv"],
    outputs: ["mp4", "webm"],
    multiInput: false,
    runtimes: ["browser", "server"],
    options: [
      {
        type: "select",
        key: "profile",
        label: "Profile",
        default: "quality-safe",
        choices: [
          { value: "quality-safe", label: "Quality-Safe" },
          { value: "web-stream", label: "Web Stream" },
          { value: "av1", label: "AV1 Ultra" },
          { value: "custom", label: "Custom" },
        ],
      },
      { type: "toggle", key: "stripAudio", label: "Strip audio track", default: false },
      { type: "range", key: "crf", label: "CRF", min: 14, max: 36, default: 23, showIf: { key: "profile", equals: ["custom"] } },
      {
        type: "select",
        key: "resolution",
        label: "Resolution",
        default: "original",
        showIf: { key: "profile", equals: ["custom"] },
        choices: [
          { value: "original", label: "Original" },
          { value: "720p", label: "720p" },
        ],
      },
    ],
  },
  simple("video-convert", "video", "convert-video", "Convert Video", ["mp4", "mov", "webm", "mkv", "avi"], ["mp4", "webm"]),
  simple("video-to-audio", "video", "video-to-audio", "Video to Audio", ["mp4", "mov", "webm"], ["mp3", "m4a"]),
  simple("audio-convert", "audio", "convert-audio", "Convert Audio", ["mp3", "wav", "ogg", "flac", "m4a"], ["mp3", "wav", "ogg"]),
  simple("audio-compress", "audio", "compress-audio", "Compress Audio", ["mp3", "wav", "ogg", "flac", "m4a"], ["mp3", "ogg"]),
  simple("font-convert", "font", "convert-font", "Convert Font", ["ttf", "otf", "woff", "woff2"], ["woff2", "woff", "ttf"]),
  { ...simple("pdf-compress", "pdf", "compress-pdf", "Compress PDF", ["pdf"], []), runtimes: ["server"] },
  { ...simple("pdf-merge", "pdf", "merge-pdf", "Merge PDF", ["pdf"], []), multiInput: true },
  simple("pdf-split", "pdf", "split-pdf", "Split PDF", ["pdf"], []),
  simple("pdf-to-images", "pdf", "pdf-to-images", "PDF to Images", ["pdf"], ["png", "jpeg"]),
  { ...simple("images-to-pdf", "pdf", "images-to-pdf", "Images to PDF", ["png", "jpg", "jpeg", "webp"], []), multiInput: true },
  { ...simple("document-convert", "document", "convert-document", "Convert Document", ["docx", "doc", "odt", "rtf"], ["pdf", "docx"]), runtimes: ["server"] },
  simple("spreadsheet-convert", "spreadsheet", "convert-spreadsheet", "Convert Spreadsheet", ["xlsx", "csv", "ods"], ["csv", "xlsx", "json"]),
];

function simple(
  id: ToolId,
  category: ToolDefinition["category"],
  slug: string,
  title: string,
  accepts: string[],
  outputs: string[],
): ToolDefinition {
  const options: OptionField[] = outputs.length
    ? [{ type: "select", key: "format", label: "Output format", default: outputs[0]!, choices: outputs.map((o) => ({ value: o, label: o.toUpperCase() })) }]
    : [];
  return { id, category, slug, title, description: `${title} online for free.`, accepts, outputs, multiInput: false, runtimes: ["browser", "server"], options };
}

function cfg(): MockConfig {
  return ((globalThis as unknown as { __MT_MOCK__?: MockConfig }).__MT_MOCK__ ?? {}) as MockConfig;
}

function abortError(): Error {
  const e = new Error("The job was cancelled");
  e.name = "AbortError";
  return e;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true },
    );
  });
}

export function createMockEngine(): Engine {
  const getTool = (idOrSlug: string) => mockTools.find((t) => t.id === idOrSlug || t.slug === idOrSlug);
  const defaults = (toolId: ToolId): Options => {
    const out: Options = {};
    for (const f of getTool(toolId)?.options ?? []) out[f.key] = f.default;
    return out;
  };
  const serverTools = () => cfg().serverTools ?? [];
  const decide = (input: JobInput): Runtime | null => {
    const t = getTool(input.toolId);
    if (!t) return null;
    for (const r of t.runtimes) {
      if (r === "browser") return "browser";
      if (r === "server" && serverTools().includes(t.id)) return "server";
    }
    return null;
  };
  return {
    tools: mockTools,
    getTool,
    defaults,
    async plan(input) {
      const r = decide(input);
      return r ? { runtime: r } : { runtime: null, reason: "This tool needs our server, which is unavailable right now." };
    },
    async run(input: JobInput, handlers: RunHandlers = {}): Promise<JobResult> {
      const c = cfg();
      const runtime = c.runtime ?? decide(input);
      if (!runtime) throw new Error("This tool needs our server, which is unavailable right now.");
      const t0 = performance.now();
      const steps = c.steps ?? 5;
      handlers.onProgress?.({ stage: "loading-engine", percent: 0, runtime });
      for (let i = 1; i <= steps; i++) {
        await sleep(c.stepMs ?? 40, handlers.signal);
        handlers.onProgress?.({ stage: "processing", percent: Math.round((i / steps) * 95), runtime, message: `Step ${i}/${steps}` });
      }
      if (c.failPattern && input.files.some((f) => new RegExp(c.failPattern!).test(f.name))) {
        throw new Error(`Mock failure for <b>${input.files[0]!.name}</b>`);
      }
      const first = input.files[0]!;
      const multi = input.toolId === "pdf-split" || input.toolId === "pdf-to-images";
      const count = c.outputs ?? (multi ? 3 : 1);
      const fmt = String(input.options.format ?? first.name.split(".").pop() ?? "bin");
      const base = first.name.replace(/\.[^.]*$/, "");
      const outputs: JobOutput[] = [];
      for (let i = 0; i < count; i++) {
        const blob = new Blob([await first.arrayBuffer()], { type: first.type || "application/octet-stream" });
        const filename = count > 1 ? `${base}-${i + 1}.${fmt}` : `${base}.${fmt}`;
        outputs.push({ blob, filename, mime: blob.type, size: blob.size });
      }
      handlers.onProgress?.({ stage: "done", percent: 100, runtime });
      return {
        runtime,
        inputSize: input.files.reduce((s, f) => s + f.size, 0),
        outputs,
        durationMs: performance.now() - t0,
        meta: c.qualityScore !== undefined ? { qualityScore: c.qualityScore } : {},
      };
    },
    async capabilities(): Promise<Capabilities> {
      return { webCodecs: "VideoEncoder" in globalThis, crossOriginIsolated: globalThis.crossOriginIsolated === true, hardwareConcurrency: navigator.hardwareConcurrency || 1, serverTools: serverTools() };
    },
  };
}
