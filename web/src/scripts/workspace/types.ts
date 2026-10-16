import type { JobResult, Runtime } from "../../../../engine/src/types.ts";

export type JobStatus = "pending" | "queued" | "processing" | "done" | "error" | "cancelled";

/** One file row in the queue. */
export interface Item {
  id: number;
  file: File;
  /** Object URL for thumbnails / "original" previews, created lazily. */
  url?: string;
  /** null until the item belongs to a job (multiInput tools create the job at run time). */
  job: Job | null;
}

/** One engine job: one item for single-input tools, every ready item for multiInput tools. */
export interface Job {
  id: number;
  items: Item[];
  status: JobStatus;
  percent: number;
  message: string;
  runtime?: Runtime;
  error?: string;
  result?: JobResult;
  /** Object URLs for result blobs (revoked when the job is discarded). */
  outputUrls: string[];
  ctrl?: AbortController;
}

export function isActive(status: JobStatus): boolean {
  return status === "queued" || status === "processing";
}
