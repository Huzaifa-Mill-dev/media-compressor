/**
 * Tool registry — the single source of truth for every tool's slug, SEO copy, accepted/produced
 * formats, runtimes and option schema. The UI renders forms from `options`; the server validates
 * against the same keys/values.
 *
 * Conventions shared with the server:
 *  - All `select` values are strings; `range`/`number` values are numbers; `toggle` is boolean.
 *  - `number` fields without a default are optional ("" / undefined = not set).
 *  - Image `format: "original"` (image-compress only) keeps the input format.
 */
import type { OptionField, ToolDefinition, ToolId } from "./types";

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const IMAGE_INPUTS = ["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "heic", "heif", "tif", "tiff"];
export const VIDEO_INPUTS = ["mp4", "m4v", "mov", "webm", "mkv", "avi", "ogv", "3gp"];
export const AUDIO_INPUTS = ["mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "weba"];
export const FONT_INPUTS = ["ttf", "otf", "woff", "woff2"];

const imageSizeFields = (): OptionField[] => [
  {
    type: "number",
    key: "width",
    advanced: true,
    label: "Max width",
    min: 1,
    max: 16384,
    placeholder: "Original",
    help: "Resize to fit within this width (px). Aspect ratio is kept; images are never upscaled.",
  },
  {
    type: "number",
    key: "height",
    advanced: true,
    label: "Max height",
    min: 1,
    max: 16384,
    placeholder: "Original",
    help: "Resize to fit within this height (px). Aspect ratio is kept; images are never upscaled.",
  },
  {
    type: "select",
    key: "effort",
    advanced: true,
    label: "Encoder effort",
    default: "balanced",
    help: "Higher effort gives smaller files but takes longer.",
    choices: [
      { value: "fast", label: "Fast" },
      { value: "balanced", label: "Balanced" },
      { value: "best", label: "Smallest file (slow)" },
    ],
  },
];

const audioBitrateChoices = ["64k", "96k", "128k", "160k", "192k", "256k", "320k"].map((v) => ({
  value: v,
  label: `${parseInt(v, 10)} kbps`,
}));

export const tools: ToolDefinition[] = [
  // ───────────────────────────── Images ─────────────────────────────
  {
    id: "image-compress",
    category: "image",
    slug: "compress-image",
    title: "Compress Images Online — JPG, PNG, WebP & AVIF",
    description:
      "Shrink JPG, PNG, WebP, AVIF and HEIC photos by up to 80% right in your browser — free, private, no uploads, batch and parallel.",
    accepts: IMAGE_INPUTS,
    outputs: ["jpg", "png", "webp", "avif"],
    multiInput: false,
    runtimes: ["browser", "server"],
    browserMaxBytes: 100 * MB,
    options: [
      {
        type: "select",
        key: "format",
        advanced: true,
        label: "Output format",
        default: "original",
        help: "Keep the original format, or convert while compressing (WebP/AVIF are usually smallest).",
        choices: [
          { value: "original", label: "Same as input" },
          { value: "webp", label: "WebP" },
          { value: "avif", label: "AVIF" },
          { value: "jpeg", label: "JPEG" },
          { value: "png", label: "PNG" },
        ],
      },
      {
        type: "range",
        key: "quality",
        advanced: true,
        label: "Quality",
        min: 1,
        max: 100,
        step: 1,
        default: 85,
        help: "Lower = smaller file. 70–80 is visually lossless for most photos. For PNG this controls colour quantisation.",
      },
      ...imageSizeFields(),
    ],
  },
  {
    id: "image-convert",
    category: "image",
    slug: "convert-image",
    title: "Image Converter — HEIC, PNG, JPG, WebP & AVIF",
    description:
      "Convert HEIC, PNG, JPG, WebP, AVIF, GIF and BMP images to WebP, AVIF, JPG or PNG instantly in your browser — free and private.",
    accepts: IMAGE_INPUTS,
    outputs: ["webp", "avif", "jpg", "png"],
    multiInput: false,
    runtimes: ["browser", "server"],
    browserMaxBytes: 100 * MB,
    options: [
      {
        type: "select",
        key: "format",
        label: "Convert to",
        default: "webp",
        choices: [
          { value: "webp", label: "WebP" },
          { value: "avif", label: "AVIF" },
          { value: "jpeg", label: "JPEG" },
          { value: "png", label: "PNG" },
        ],
      },
      {
        type: "range",
        key: "quality",
        advanced: true,
        label: "Quality",
        min: 1,
        max: 100,
        step: 1,
        default: 85,
        help: "Ignored for PNG unless below 100 (then PNG colours are quantised).",
        showIf: { key: "format", equals: ["webp", "avif", "jpeg", "png"] },
      },
      ...imageSizeFields(),
    ],
  },

  // ───────────────────────────── Video ─────────────────────────────
  {
    id: "video-compress",
    category: "video",
    slug: "compress-video",
    title: "Compress Video Online — MP4, MOV & WebM",
    description:
      "Reduce MP4, MOV, WebM and MKV video size without visible quality loss, using your device's hardware encoder — no upload, no watermark.",
    accepts: VIDEO_INPUTS,
    outputs: ["mp4", "webm"],
    multiInput: false,
    runtimes: ["browser", "server"],
    browserMaxBytes: 800 * MB,
    options: [
      {
        type: "select",
        key: "profile",
        advanced: true,
        label: "Profile",
        default: "quality-safe",
        choices: [
          { value: "quality-safe", label: "Quality-safe (H.264, native resolution)" },
          { value: "web-stream", label: "Web streaming (720p, smallest H.264)" },
          { value: "av1", label: "AV1 (best compression, slower)" },
          { value: "custom", label: "Custom" },
        ],
      },
      {
        type: "select",
        key: "format",
        advanced: true,
        label: "Container",
        default: "mp4",
        showIf: { key: "profile", equals: ["custom"] },
        choices: [
          { value: "mp4", label: "MP4" },
          { value: "webm", label: "WebM" },
        ],
      },
      {
        type: "select",
        key: "codec",
        advanced: true,
        label: "Video codec",
        default: "h264",
        showIf: { key: "profile", equals: ["custom"] },
        help: "WebM supports VP9 and AV1 only; H.264/H.265 are written to MP4.",
        choices: [
          { value: "h264", label: "H.264 (most compatible)" },
          { value: "h265", label: "H.265 / HEVC" },
          { value: "vp9", label: "VP9" },
          { value: "av1", label: "AV1" },
        ],
      },
      {
        type: "range",
        key: "crf",
        advanced: true,
        label: "Quality (CRF)",
        min: 14,
        max: 40,
        step: 1,
        default: 23,
        help: "Lower = higher quality and bigger file. 18 is visually lossless, 28 is small.",
        showIf: { key: "profile", equals: ["custom"] },
      },
      {
        type: "select",
        key: "resolution",
        advanced: true,
        label: "Max resolution",
        default: "original",
        showIf: { key: "profile", equals: ["custom"] },
        choices: [
          { value: "original", label: "Original" },
          { value: "1440p", label: "1440p" },
          { value: "1080p", label: "1080p" },
          { value: "720p", label: "720p" },
          { value: "480p", label: "480p" },
        ],
      },
      {
        type: "select",
        key: "audioBitrate",
        advanced: true,
        label: "Audio bitrate",
        default: "128k",
        showIf: { key: "profile", equals: ["custom"] },
        choices: audioBitrateChoices.filter((c) => parseInt(c.value, 10) <= 256),
      },
      { type: "toggle", key: "stripAudio", label: "Remove audio", default: false, advanced: true },
    ],
  },
  {
    id: "video-convert",
    category: "video",
    slug: "convert-video",
    title: "Video Converter — MOV, MP4, WebM & GIF",
    description:
      "Convert videos between MP4, WebM, MOV and MKV or turn clips into GIFs, directly in your browser — fast, free and private.",
    accepts: VIDEO_INPUTS,
    outputs: ["mp4", "webm", "mov", "mkv", "gif"],
    multiInput: false,
    runtimes: ["browser", "server"],
    browserMaxBytes: 800 * MB,
    options: [
      {
        type: "select",
        key: "format",
        label: "Convert to",
        default: "mp4",
        choices: [
          { value: "mp4", label: "MP4" },
          { value: "webm", label: "WebM" },
          { value: "mov", label: "MOV" },
          { value: "mkv", label: "MKV" },
          { value: "gif", label: "GIF (animated)" },
        ],
      },
      {
        type: "select",
        key: "resolution",
        advanced: true,
        label: "Max resolution",
        default: "original",
        help: "GIFs are capped at 480p regardless.",
        choices: [
          { value: "original", label: "Original" },
          { value: "1440p", label: "1440p" },
          { value: "1080p", label: "1080p" },
          { value: "720p", label: "720p" },
          { value: "480p", label: "480p" },
        ],
      },
      {
        type: "toggle",
        key: "stripAudio",
        advanced: true,
        label: "Remove audio",
        default: false,
        showIf: { key: "format", equals: ["mp4", "webm", "mov", "mkv"] },
      },
    ],
  },
  {
    id: "video-to-audio",
    category: "audio",
    slug: "extract-audio",
    title: "Extract Audio from Video — MP4 to MP3, M4A, WAV",
    description:
      "Pull the soundtrack out of any MP4, MOV, WebM or MKV video and save it as MP3, M4A, Opus, WAV or FLAC — in your browser.",
    accepts: VIDEO_INPUTS,
    outputs: ["mp3", "m4a", "ogg", "opus", "wav", "flac"],
    multiInput: false,
    runtimes: ["browser", "server"],
    browserMaxBytes: 800 * MB,
    options: [
      {
        type: "select",
        key: "format",
        label: "Audio format",
        default: "mp3",
        choices: [
          { value: "mp3", label: "MP3" },
          { value: "m4a", label: "M4A (AAC)" },
          { value: "ogg", label: "OGG (Opus)" },
          { value: "opus", label: "Opus" },
          { value: "wav", label: "WAV (lossless)" },
          { value: "flac", label: "FLAC (lossless)" },
        ],
      },
      {
        type: "select",
        key: "bitrate",
        advanced: true,
        label: "Bitrate",
        default: "192k",
        showIf: { key: "format", equals: ["mp3", "m4a", "ogg", "opus"] },
        choices: audioBitrateChoices,
      },
    ],
  },

  // ───────────────────────────── Audio ─────────────────────────────
  {
    id: "audio-convert",
    category: "audio",
    slug: "convert-audio",
    title: "Audio Converter — WAV, MP3, M4A, FLAC & OGG",
    description:
      "Convert WAV, MP3, M4A, FLAC, OGG and Opus audio files to any other format instantly in your browser — free, no sign-up.",
    accepts: AUDIO_INPUTS,
    outputs: ["mp3", "m4a", "ogg", "opus", "wav", "flac"],
    multiInput: false,
    runtimes: ["browser", "server"],
    browserMaxBytes: 1 * GB,
    options: [
      {
        type: "select",
        key: "format",
        label: "Convert to",
        default: "mp3",
        choices: [
          { value: "mp3", label: "MP3" },
          { value: "m4a", label: "M4A (AAC)" },
          { value: "ogg", label: "OGG (Opus)" },
          { value: "opus", label: "Opus" },
          { value: "wav", label: "WAV" },
          { value: "flac", label: "FLAC" },
        ],
      },
      {
        type: "select",
        key: "bitrate",
        advanced: true,
        label: "Bitrate",
        default: "192k",
        showIf: { key: "format", equals: ["mp3", "m4a", "ogg", "opus"] },
        choices: audioBitrateChoices,
      },
    ],
  },
  {
    id: "audio-compress",
    category: "audio",
    slug: "compress-audio",
    title: "Compress Audio Files — Shrink MP3, WAV & M4A",
    description:
      "Make MP3, WAV, M4A and FLAC files smaller by re-encoding at a lower bitrate, right in your browser — private and free.",
    accepts: AUDIO_INPUTS,
    outputs: ["mp3", "m4a", "ogg", "opus"],
    multiInput: false,
    runtimes: ["browser", "server"],
    browserMaxBytes: 1 * GB,
    options: [
      {
        type: "select",
        key: "format",
        advanced: true,
        label: "Output format",
        default: "mp3",
        choices: [
          { value: "mp3", label: "MP3" },
          { value: "m4a", label: "M4A (AAC)" },
          { value: "ogg", label: "OGG (Opus)" },
          { value: "opus", label: "Opus" },
        ],
      },
      { type: "select", key: "bitrate", label: "Bitrate", default: "128k", choices: audioBitrateChoices, advanced: true },
    ],
  },

  // ───────────────────────────── Fonts ─────────────────────────────
  {
    id: "font-convert",
    category: "font",
    slug: "convert-font",
    title: "Font Converter — TTF, OTF to WOFF2 & WOFF",
    description:
      "Convert TTF and OTF fonts to compressed WOFF2 or WOFF web fonts (and back) in your browser — perfect for faster websites.",
    accepts: FONT_INPUTS,
    outputs: ["woff2", "woff", "ttf", "otf"],
    multiInput: false,
    runtimes: ["browser", "server"],
    browserMaxBytes: 50 * MB,
    options: [
      {
        type: "select",
        key: "format",
        label: "Convert to",
        default: "woff2",
        help: "TrueType ↔ OpenType (CFF) outline conversion runs on our server.",
        choices: [
          { value: "woff2", label: "WOFF2 (best for web)" },
          { value: "woff", label: "WOFF" },
          { value: "ttf", label: "TTF (TrueType)" },
          { value: "otf", label: "OTF (OpenType)" },
        ],
      },
    ],
  },

  // ───────────────────────────── PDF ─────────────────────────────
  {
    id: "pdf-compress",
    category: "pdf",
    slug: "compress-pdf",
    title: "Compress PDF — Reduce PDF File Size",
    description:
      "Reduce PDF file size for email and upload by optimising images and fonts, with a choice of screen, ebook or print quality.",
    accepts: ["pdf"],
    outputs: ["pdf"],
    multiInput: false,
    runtimes: ["server"],
    options: [
      {
        type: "select",
        key: "level",
        advanced: true,
        label: "Compression level",
        default: "ebook",
        choices: [
          { value: "screen", label: "Strong (72 dpi, smallest)" },
          { value: "ebook", label: "Recommended (150 dpi)" },
          { value: "printer", label: "Light (300 dpi, print quality)" },
        ],
      },
    ],
  },
  {
    id: "pdf-merge",
    category: "pdf",
    slug: "merge-pdf",
    title: "Merge PDF Files — Combine PDFs Online",
    description:
      "Combine multiple PDF files into one document in the order you choose — instantly in your browser, nothing is uploaded.",
    accepts: ["pdf"],
    outputs: ["pdf"],
    multiInput: true,
    runtimes: ["browser", "server"],
    browserMaxBytes: 300 * MB,
    options: [],
  },
  {
    id: "pdf-split",
    category: "pdf",
    slug: "split-pdf",
    title: "Split PDF — Extract Pages from a PDF",
    description:
      "Split a PDF into single pages or extract custom page ranges into separate PDF files, privately in your browser.",
    accepts: ["pdf"],
    outputs: ["pdf"],
    multiInput: false,
    runtimes: ["browser", "server"],
    browserMaxBytes: 300 * MB,
    options: [
      {
        type: "select",
        key: "mode",
        label: "Split mode",
        default: "every",
        choices: [
          { value: "every", label: "Every page as its own PDF" },
          { value: "ranges", label: "Custom page ranges" },
        ],
      },
      {
        type: "text",
        key: "ranges",
        label: "Page ranges",
        default: "",
        placeholder: "1-3, 5, 8-10",
        help: "Comma-separated pages or ranges; each entry becomes one PDF. Use 'end' for the last page, e.g. 4-end.",
        showIf: { key: "mode", equals: ["ranges"] },
      },
    ],
  },
  {
    id: "pdf-to-images",
    category: "pdf",
    slug: "pdf-to-image",
    title: "PDF to JPG & PNG — Convert PDF Pages to Images",
    description:
      "Turn every page of a PDF into a high-resolution PNG or JPG image at the DPI you need — fast and private, in your browser.",
    accepts: ["pdf"],
    outputs: ["png", "jpg"],
    multiInput: false,
    runtimes: ["browser", "server"],
    browserMaxBytes: 200 * MB,
    options: [
      {
        type: "select",
        key: "format",
        label: "Image format",
        default: "png",
        choices: [
          { value: "png", label: "PNG (sharp text)" },
          { value: "jpeg", label: "JPEG (smaller)" },
        ],
      },
      { type: "range", key: "dpi", label: "Resolution", min: 72, max: 300, step: 1, default: 200, unit: "dpi", advanced: true },
    ],
  },
  {
    id: "images-to-pdf",
    category: "pdf",
    slug: "images-to-pdf",
    title: "JPG & PNG to PDF — Convert Images to PDF",
    description:
      "Combine JPG, PNG, WebP and HEIC images into a single PDF, one image per page, with optional A4/Letter pages and margins.",
    accepts: ["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "heic", "heif"],
    outputs: ["pdf"],
    multiInput: true,
    runtimes: ["browser", "server"],
    browserMaxBytes: 100 * MB,
    options: [
      {
        type: "select",
        key: "pageSize",
        advanced: true,
        label: "Page size",
        default: "fit",
        choices: [
          { value: "fit", label: "Fit page to image" },
          { value: "a4", label: "A4" },
          { value: "letter", label: "US Letter" },
        ],
      },
      { type: "range", key: "margin", label: "Margin", min: 0, max: 50, step: 1, default: 0, unit: "mm", advanced: true },
    ],
  },

  // ───────────────────────────── Documents ─────────────────────────────
  {
    id: "document-convert",
    category: "document",
    slug: "convert-document",
    title: "Document Converter — Word to PDF, DOCX, ODT",
    description:
      "Convert Word, OpenDocument, RTF, PowerPoint and text documents to PDF, DOCX, ODT, HTML or plain text with high fidelity.",
    accepts: ["doc", "docx", "odt", "rtf", "txt", "html", "htm", "ppt", "pptx", "odp"],
    outputs: ["pdf", "docx", "odt", "rtf", "txt", "html"],
    multiInput: false,
    runtimes: ["server"],
    options: [
      {
        type: "select",
        key: "format",
        label: "Convert to",
        default: "pdf",
        help: "Presentations (PPT/PPTX/ODP) can only be converted to PDF.",
        choices: [
          { value: "pdf", label: "PDF" },
          { value: "docx", label: "Word (DOCX)" },
          { value: "odt", label: "OpenDocument (ODT)" },
          { value: "rtf", label: "Rich Text (RTF)" },
          { value: "txt", label: "Plain text (TXT)" },
          { value: "html", label: "HTML" },
        ],
      },
    ],
  },
  {
    id: "spreadsheet-convert",
    category: "spreadsheet",
    slug: "convert-spreadsheet",
    title: "Spreadsheet Converter — Excel to CSV, CSV to Excel",
    description:
      "Convert Excel XLSX, XLS, ODS and CSV spreadsheets to CSV, XLSX, JSON, ODS or PDF — XLSX/CSV/JSON run entirely in your browser.",
    accepts: ["xlsx", "xls", "ods", "csv", "json"],
    outputs: ["csv", "xlsx", "json", "ods", "pdf"],
    multiInput: false,
    runtimes: ["browser", "server"],
    browserMaxBytes: 50 * MB,
    options: [
      {
        type: "select",
        key: "format",
        label: "Convert to",
        default: "csv",
        choices: [
          { value: "csv", label: "CSV" },
          { value: "xlsx", label: "Excel (XLSX)" },
          { value: "json", label: "JSON" },
          { value: "ods", label: "OpenDocument (ODS)" },
          { value: "pdf", label: "PDF" },
        ],
      },
      {
        type: "select",
        key: "sheets",
        advanced: true,
        label: "Sheets",
        default: "first",
        help: "For workbooks with several sheets: export only the first, or one file per sheet.",
        showIf: { key: "format", equals: ["csv", "json"] },
        choices: [
          { value: "first", label: "First sheet only" },
          { value: "all", label: "All sheets (one file each)" },
        ],
      },
    ],
  },
];

export const toolsById: Record<ToolId, ToolDefinition> = Object.fromEntries(tools.map((t) => [t.id, t])) as Record<
  ToolId,
  ToolDefinition
>;

export function getTool(idOrSlug: string): ToolDefinition | undefined {
  return tools.find((t) => t.id === idOrSlug || t.slug === idOrSlug);
}
