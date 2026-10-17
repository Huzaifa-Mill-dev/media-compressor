import { serveWorker } from "../worker-host";

const load = async () => (await import("../processors/media")).processMedia;
serveWorker({
  "video-compress": load,
  "video-convert": load,
  "video-to-audio": load,
  "audio-convert": load,
  "audio-compress": load,
});
