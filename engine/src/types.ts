/**
 * SHARED CONTRACT — owned by the lead. Agents must not change these types
 * without asking; the web UI and the server both code against them.
 */

export type Category = "image" | "video" | "audio" | "font" | "pdf" | "document" | "spreadsheet";

/** Where a job actually executed. */
export type Runtime = "browser" | "server";

export type ToolId =
  | "image-compress"
  | "image-convert"
  | "video-compress"
  | "video-convert"
  | "video-to-audio"
  | "audio-convert"
  | "audio-compress"
  | "font-convert"
  | "pdf-compress"
  | "pdf-merge"
  | "pdf-split"
  | "pdf-to-images"
  | "images-to-pdf"
  | "document-convert"
  | "spreadsheet-convert";

/** Declarative option schema — the UI renders forms from this, it never hardcodes per-tool fields. */
export type OptionField =
  | ({ type: "select"; choices: { value: string; label: string }[]; default: string } & FieldBase)
  | ({ type: "range"; min: number; max: number; step?: number; default: number; unit?: string } & FieldBase)
  | ({ type: "number"; min?: number; max?: number; default?: number; placeholder?: string } & FieldBase)
  | ({ type: "toggle"; default: boolean } & FieldBase)
  | ({ type: "text"; default?: string; placeholder?: string } & FieldBase);

interface FieldBase {
  key: string;
  label: string;
  help?: string;
  /** Show this field only when another option has one of these values. */
  showIf?: { key: string; equals: (string | number | boolean)[] };
}

export interface ToolDefinition {
  id: ToolId;
  category: Category;
  /** URL slug for the tool's page, e.g. "compress-image" → /compress-image */
  slug: string;
  title: string;
  /** One-sentence, SEO-friendly description. */
  description: string;
  /** Accepted input extensions, lowercase without dot, e.g. ["png","jpg"]. */
  accepts: string[];
  /** Possible output formats (extensions). Empty when output is implied (e.g. pdf-merge → pdf). */
  outputs: string[];
  /** true for tools that take several files and produce one output (pdf-merge, images-to-pdf). */
  multiInput: boolean;
  /** Runtimes this tool supports, in preference order. */
  runtimes: Runtime[];
  options: OptionField[];
  /** Max input size per file in bytes for in-browser processing; larger files go to the server if supported. */
  browserMaxBytes?: number;
}

export type Options = Record<string, string | number | boolean | undefined>;

export interface JobInput {
  toolId: ToolId;
  /** One file for single-input tools; ordered list for multiInput tools. */
  files: File[];
  options: Options;
  /** Force a runtime (debug / user override). Default: engine decides. */
  preferRuntime?: Runtime;
}

export type JobStage =
  | "queued"
  | "loading-engine" // downloading/initialising a WASM codec
  | "uploading" // server runtime only
  | "processing"
  | "finalizing"
  | "done"
  | "error"
  | "cancelled";

export interface JobProgress {
  stage: JobStage;
  /** 0–100 for the whole job. */
  percent: number;
  message?: string;
  runtime: Runtime;
}

export interface JobOutput {
  blob: Blob;
  filename: string;
  mime: string;
  size: number;
}

export interface JobResult {
  runtime: Runtime;
  /** Sum of input sizes. */
  inputSize: number;
  /** Primary output first. pdf-split / pdf-to-images produce several. */
  outputs: JobOutput[];
  durationMs: number;
  meta?: {
    width?: number;
    height?: number;
    outputWidth?: number;
    outputHeight?: number;
    durationSec?: number;
    pages?: number;
    /** 0–100 SSIM-derived similarity, when computed. */
    qualityScore?: number;
    codec?: string;
    [k: string]: unknown;
  };
}

export interface RunHandlers {
  onProgress?: (p: JobProgress) => void;
  signal?: AbortSignal;
}

export interface Capabilities {
  webCodecs: boolean;
  /** SharedArrayBuffer available (page is cross-origin isolated) → multithreaded WASM. */
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
  /** Tool ids the server reports it can run (from GET /api/capabilities); empty if offline. */
  serverTools: ToolId[];
}

/** The public surface of the engine package. The UI imports ONLY this (from engine/src/index.ts). */
export interface Engine {
  tools: ToolDefinition[];
  getTool(idOrSlug: string): ToolDefinition | undefined;
  /** Default option values for a tool. */
  defaults(toolId: ToolId): Options;
  /** Decide where a job would run, without running it. Returns null + reason if it can't run anywhere. */
  plan(input: JobInput): Promise<{ runtime: Runtime } | { runtime: null; reason: string }>;
  /**
   * Run a job. Jobs are scheduled on an internal pool (browser jobs in parallel up to
   * a concurrency limit; server jobs serialized per the server's queue). Rejects with
   * an Error whose name is "AbortError" when cancelled.
   */
  run(input: JobInput, handlers?: RunHandlers): Promise<JobResult>;
  capabilities(): Promise<Capabilities>;
}
