import { serveWorker } from "../worker-host";

serveWorker({
  "font-convert": async () => (await import("../processors/font")).processFont,
  "pdf-merge": async () => (await import("../processors/pdf")).processPdf,
  "pdf-split": async () => (await import("../processors/pdf")).processPdf,
  "images-to-pdf": async () => (await import("../processors/pdf")).processPdf,
  "spreadsheet-convert": async () => (await import("../processors/sheet")).processSheet,
});
