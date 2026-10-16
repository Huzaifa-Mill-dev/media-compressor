/** Message protocol between the main thread (runner) and the job workers, plus processor contracts. */
import type { JobResult, JobStage, Options, ToolId } from "./types";
import type { SerializedError } from "./errors";

/** Which worker script handles a tool. Each kind has its own warm pool. */
export type WorkerKind = "image" | "media" | "doc";

export function workerKindFor(toolId: ToolId): WorkerKind {
  switch (toolId) {
    case "image-compress":
    case "image-convert":
      return "image";
    case "video-compress":
    case "video-convert":
    case "video-to-audio":
    case "audio-convert":
    case "audio-compress":
      return "media";
    default:
      return "doc";
  }
}

/** Per-job environment forwarded to the worker. */
export interface WorkerEnvInfo {
  /** Absolute or origin-relative base URL where copy-assets put static assets, with trailing slash. */
  vendorBase: string;
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
}

export interface RunMessage {
  type: "run";
  id: number;
  toolId: ToolId;
  files: File[];
  options: Options;
  env: WorkerEnvInfo;
}

export interface ProgressMessage {
  type: "progress";
  id: number;
  stage: JobStage;
  percent: number;
  message?: string;
}

export type ProcResult = Pick<JobResult, "outputs" | "meta">;

export interface DoneMessage {
  type: "done";
  id: number;
  result: ProcResult;
}

export interface ErrorMessage {
  type: "error";
  id: number;
  error: SerializedError;
}

export type ToWorker = RunMessage;
export type FromWorker = ProgressMessage | DoneMessage | ErrorMessage;

/** What every processor receives. Runs inside a worker (or node, for pure processors). */
export interface ProcCtx {
  toolId: ToolId;
  files: File[];
  options: Options;
  env: WorkerEnvInfo;
  progress(stage: JobStage, percent: number, message?: string): void;
}

export type Processor = (ctx: ProcCtx) => Promise<ProcResult>;
