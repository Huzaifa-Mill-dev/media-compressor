import type { ToolDefinition } from "../../../../engine/src/types.ts";
import { formatList } from "../../lib/content";
import { formatSize } from "../../lib/format";
import { fileExt } from "./media";

export const MAX_QUEUE = 200;

export interface Rejection {
  name: string;
  reason: string;
}

export interface Screened {
  accepted: File[];
  rejected: Rejection[];
}

/** Decide which dropped/pasted/picked files this tool can take. Never trusts the file name for display. */
export function screenFiles(tool: ToolDefinition, files: File[], currentCount: number): Screened {
  const accepted: File[] = [];
  const rejected: Rejection[] = [];
  const allowed = new Set(tool.accepts.map((e) => e.toLowerCase()));
  for (const file of files) {
    const ext = fileExt(file);
    if (!ext || !allowed.has(ext)) {
      rejected.push({
        name: file.name || "(unnamed)",
        reason: ext
          ? `.${ext} files are not supported here. Accepted: ${formatList(tool.accepts)}.`
          : `Unrecognised file type. Accepted: ${formatList(tool.accepts)}.`,
      });
    } else if (file.size === 0) {
      rejected.push({ name: file.name || "(unnamed)", reason: "The file is empty." });
    } else if (currentCount + accepted.length >= MAX_QUEUE) {
      rejected.push({ name: file.name || "(unnamed)", reason: `Queue is full (max ${MAX_QUEUE} files).` });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}

/** Browsers name pasted images "image.png"; give the others a stable name too. */
export function normaliseName(file: File): File {
  if (file.name) return file;
  const ext = fileExt(file) || "bin";
  return new File([file], `pasted.${ext}`, { type: file.type, lastModified: file.lastModified });
}

export function sizeHint(tool: ToolDefinition): string {
  const parts: string[] = [];
  if (tool.browserMaxBytes) parts.push(`On-device up to ${formatSize(tool.browserMaxBytes)} per file`);
  if (tool.multiInput) parts.push("Files are combined in the order shown");
  return parts.join(" · ");
}
