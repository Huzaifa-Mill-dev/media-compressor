import type { ToolId } from "@contracts/types";
import { processFont } from "./font.js";
import { processImage } from "./image.js";
import { processMedia } from "./media.js";
import { processOffice } from "./office.js";
import { compressPdf, imagesToPdf, mergePdf, pdfToImages, splitPdf } from "./pdf.js";
import type { Processor } from "./types.js";

export const PROCESSORS: Record<ToolId, Processor> = {
  "image-compress": processImage,
  "image-convert": processImage,
  "video-compress": processMedia,
  "video-convert": processMedia,
  "video-to-audio": processMedia,
  "audio-convert": processMedia,
  "audio-compress": processMedia,
  "font-convert": processFont,
  "pdf-compress": compressPdf,
  "pdf-merge": mergePdf,
  "pdf-split": splitPdf,
  "pdf-to-images": pdfToImages,
  "images-to-pdf": imagesToPdf,
  "document-convert": processOffice,
  "spreadsheet-convert": processOffice,
};
export type { ProcCtx, ProcResult } from "./types.js";
