import { serveWorker } from "../worker-host";

serveWorker({
  "image-compress": async () => (await import("../processors/image")).processImage,
  "image-convert": async () => (await import("../processors/image")).processImage,
});
