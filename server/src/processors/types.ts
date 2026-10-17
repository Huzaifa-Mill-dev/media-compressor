import type { ToolId } from "@contracts/types";
import type { ServerConfig } from "../config.js";
import type { Binaries } from "../probe.js";
import type { ResolvedOptions } from "../tools.js";

export interface ProcInput {
  /** Absolute path of the stored upload (neutral name: `<n>.<ext>`). */
  path: string;
  /** Sanitized original file name (display / output naming only). */
  name: string;
  ext: string;
  size: number;
}

export interface ProcCtx {
  toolId: ToolId;
  inputs: ProcInput[];
  options: ResolvedOptions;
  /** Empty directory for the outputs. */
  outDir: string;
  /** Scratch directory (deleted with the job). */
  workDir: string;
  signal: AbortSignal;
  progress(percent: number, message?: string): void;
  cfg: ServerConfig;
  bins: Binaries;
}

export interface ProcOutput {
  path: string;
  /** Download name (already sanitized). */
  name: string;
}

export interface ProcResult {
  outputs: ProcOutput[];
  meta?: Record<string, unknown>;
}

export type Processor = (ctx: ProcCtx) => Promise<ProcResult>;
