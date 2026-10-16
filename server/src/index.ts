import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { probeBinaries } from "./probe.js";
import { killAllChildren, setPrlimit } from "./proc.js";
import { availableTools } from "./tools.js";

const cfg = loadConfig();
const log = createLogger(cfg.logLevel);
const bins = await probeBinaries(cfg.python);
setPrlimit(bins.prlimit);
const { app, close } = await createApp(cfg, bins);

const server = app.listen(cfg.port, cfg.host, () => {
  log.info("server started", { port: cfg.port, tools: availableTools(bins), versions: bins.versions });
});
// Uploads can take a while on slow links; processing is asynchronous so keep request timeouts generous.
server.requestTimeout = 0;
server.headersTimeout = 30_000;

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  killAllChildren();
  server.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
