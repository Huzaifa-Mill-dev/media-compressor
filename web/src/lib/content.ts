/** Static marketing / SEO copy derived generically from the tool registry. */
import type { Category, ToolDefinition, ToolId } from "../../../engine/src/types.ts";

export const SITE_NAME = "Media Toolkit";
export const SITE_TAGLINE = "Efficient files, human touch";

export interface CategoryInfo {
  label: string;
  /** Plural noun used in copy ("images", "videos"). */
  noun: string;
  blurb: string;
  /** SVG path data for a 24×24 stroke icon. */
  icon: string[];
}

export const CATEGORIES: Record<Category, CategoryInfo> = {
  image: {
    label: "Image",
    noun: "images",
    blurb: "Compress and convert PNG, JPEG, WebP, AVIF and HEIC.",
    icon: ["M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z", "M21 15l-5-5L5 21"],
  },
  video: {
    label: "Video",
    noun: "videos",
    blurb: "Shrink MP4, MOV and WebM with hardware encoders, or extract audio.",
    icon: ["M23 7l-7 5 7 5z", "M3 5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"],
  },
  audio: {
    label: "Audio",
    noun: "audio files",
    blurb: "Convert and compress MP3, WAV, OGG, FLAC and M4A.",
    icon: ["M9 18V5l12-2v13", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  },
  font: {
    label: "Font",
    noun: "fonts",
    blurb: "Convert TTF, OTF, WOFF and WOFF2 web fonts.",
    icon: ["M4 7V4h16v3", "M9 20h6", "M12 4v16"],
  },
  pdf: {
    label: "PDF",
    noun: "PDFs",
    blurb: "Merge, split, compress and convert PDF files.",
    icon: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M9 15h6", "M9 11h2"],
  },
  document: {
    label: "Document",
    noun: "documents",
    blurb: "Convert Word, ODT and RTF documents to PDF and back.",
    icon: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M16 13H8", "M16 17H8", "M10 9H8"],
  },
  spreadsheet: {
    label: "Spreadsheet",
    noun: "spreadsheets",
    blurb: "Convert between XLSX, CSV, JSON and ODS.",
    icon: ["M3 3h18v18H3z", "M3 9h18", "M3 15h18", "M9 3v18", "M15 3v18"],
  },
};

export function formatList(items: string[]): string {
  const up = items.map((s) => s.toUpperCase());
  if (up.length <= 1) return up.join("");
  return `${up.slice(0, -1).join(", ")} and ${up[up.length - 1]}`;
}

export function runsInBrowser(tool: ToolDefinition): boolean {
  return tool.runtimes.includes("browser");
}

export function howTo(tool: ToolDefinition): string[] {
  const noun = CATEGORIES[tool.category].noun;
  const steps = [
    tool.multiInput
      ? `Add your ${formatList(tool.accepts)} files — drag and drop, click to browse, or paste.`
      : `Add one or more ${formatList(tool.accepts)} ${noun} — drag and drop, click to browse, or paste.`,
  ];
  if (tool.multiInput) steps.push("Put the files in the order you want using the arrows or the drag handle.");
  if (tool.options.length > 0) steps.push("Adjust the options, or keep the recommended defaults.");
  steps.push(`Press “${actionLabel(tool)}” and download each result, or everything at once as a ZIP.`);
  return steps;
}

const VERBS: Record<ToolId, string> = {
  "image-compress": "Compress",
  "image-convert": "Convert",
  "video-compress": "Compress",
  "video-convert": "Convert",
  "video-to-audio": "Extract audio",
  "audio-convert": "Convert",
  "audio-compress": "Compress",
  "font-convert": "Convert",
  "pdf-compress": "Compress",
  "pdf-merge": "Merge",
  "pdf-split": "Split",
  "pdf-to-images": "Convert",
  "images-to-pdf": "Create PDF",
  "pdf-to-docx": "Convert",
  "document-convert": "Convert",
  "spreadsheet-convert": "Convert",
};

/** Minimum number of files a job needs (merging one PDF is meaningless). */
export function minFiles(tool: ToolDefinition): number {
  return tool.id === "pdf-merge" ? 2 : 1;
}

/** Primary button label, e.g. "Compress" / "Merge". */
export function actionLabel(tool: ToolDefinition): string {
  return VERBS[tool.id] ?? "Start";
}

/** "Compress Images Online — JPG, PNG…" → "Compress Images Online" (used for H1 and copy). */
export function shortTitle(tool: ToolDefinition): string {
  return tool.title.split(/\s+[—–-]\s+/)[0] ?? tool.title;
}

export function toolHref(tool: ToolDefinition): string {
  return `/${tool.slug}`;
}

/** Serialise JSON for an inline <script> data block so it can never close the element. */
export function jsonForScript(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function faq(tool: ToolDefinition): { q: string; a: string }[] {
  const browser = runsInBrowser(tool);
  const server = tool.runtimes.includes("server");
  const items: { q: string; a: string }[] = [
    {
      q: `Is ${shortTitle(tool)} free?`,
      a: `Yes. ${shortTitle(tool)} is free to use, with no sign-up, no watermark and no daily limit.`,
    },
    {
      q: "Are my files uploaded?",
      a: browser
        ? server
          ? "Usually not. Processing happens on your device in the browser. Only when your browser cannot handle a file (for example, a very large one) is it sent to our server, processed, and deleted automatically within 30 minutes."
          : "No. This tool runs entirely on your device in your browser; your files never leave your computer."
        : "This tool needs our server. Files are sent over HTTPS, processed in an isolated temporary folder, and deleted automatically within 30 minutes. We never keep or share them.",
    },
    {
      q: "Which formats are supported?",
      a:
        `Input: ${formatList(tool.accepts)}.` + (tool.outputs.length ? ` Output: ${formatList(tool.outputs)}.` : ""),
    },
  ];
  if (tool.browserMaxBytes) {
    items.push({
      q: "Is there a file size limit?",
      a: `Files up to ${Math.round(tool.browserMaxBytes / 1024 / 1024)} MB are processed on your device. Larger files are handled by our server when it is available.`,
    });
  }
  if (!tool.multiInput) {
    items.push({
      q: "Can I process several files at once?",
      a: "Yes. Add as many files as you like; they are processed in parallel and you can download them all as a single ZIP.",
    });
  }
  return items;
}
