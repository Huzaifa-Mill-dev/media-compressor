import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (server/src → ../..; server/dist → ../..). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ServerConfig {
  port: number;
  host: string;
  version: string;
  /** Persistent data (stats.json). */
  dataDir: string;
  /** Per-job working directories live here (one sub-dir per job id). */
  jobsDir: string;
  webDist: string;
  maxFileBytes: number;
  /** Total multipart body cap (all files together). */
  maxTotalBytes: number;
  maxFiles: number;
  /** Max jobs that are uploading, queued or running at once → 429 beyond. */
  maxQueue: number;
  heavyConcurrency: number;
  lightConcurrency: number;
  /** How long finished outputs stay downloadable. */
  outputTtlMs: number;
  /** Rate limit for POST /api/jobs. */
  rateLimitMax: number;
  rateLimitWindowMs: number;
  trustProxy: boolean | number | string;
  /** sharp limitInputPixels. */
  maxImagePixels: number;
  /** ffprobe guards. */
  maxVideoPixels: number;
  maxMediaSeconds: number;
  maxPdfPages: number;
  /** GIF output is capped to this many seconds. */
  maxGifSeconds: number;
  /** Address-space limit (MB) applied to child processes via prlimit when available; 0 disables. */
  childMemLimitMb: number;
  /** Multiplies every per-tool timeout (tests shrink it, slow hosts may grow it). */
  timeoutScale: number;
  s3Bucket: string | null;
  s3Region: string;
  /** Python interpreter used for fontTools. */
  python: string;
  logLevel: "silent" | "error" | "info";
}

function num(env: NodeJS.ProcessEnv, key: string, def: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`Invalid ${key}=${raw}`);
  return n;
}

export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw === "" || raw === "false" || raw === "0") return false;
  if (raw === "true") return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw; // e.g. "loopback" or "loopback, 10.0.0.0/8" — passed to express as-is
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const maxFileMb = num(env, "MAX_FILE_MB", 500, 1);
  const cfg: ServerConfig = {
    port: num(env, "PORT", 3000),
    host: env.HOST || "0.0.0.0",
    version: env.APP_VERSION || "2.0.0",
    dataDir: path.resolve(env.DATA_DIR || path.join(REPO_ROOT, "data")),
    jobsDir: path.resolve(env.JOBS_DIR || path.join(os.tmpdir(), "media-toolkit-jobs")),
    webDist: path.resolve(env.WEB_DIST || path.join(REPO_ROOT, "web", "dist")),
    maxFileBytes: Math.round(maxFileMb * 1024 * 1024),
    maxTotalBytes: Math.round(num(env, "MAX_TOTAL_MB", Math.max(maxFileMb, 1000), 1) * 1024 * 1024),
    maxFiles: num(env, "MAX_FILES", 20, 1),
    maxQueue: num(env, "MAX_QUEUE", 20, 1),
    heavyConcurrency: num(env, "HEAVY_CONCURRENCY", 1, 1),
    lightConcurrency: num(env, "LIGHT_CONCURRENCY", 2, 1),
    outputTtlMs: num(env, "OUTPUT_TTL_MS", 30 * 60 * 1000, 100),
    rateLimitMax: num(env, "RATE_LIMIT_MAX", 30, 1),
    rateLimitWindowMs: num(env, "RATE_LIMIT_WINDOW_MS", 60_000, 100),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    maxImagePixels: num(env, "MAX_IMAGE_PIXELS", 100_000_000, 1),
    maxVideoPixels: num(env, "MAX_VIDEO_PIXELS", 8192 * 4320, 1),
    maxMediaSeconds: num(env, "MAX_MEDIA_SECONDS", 4 * 3600, 1),
    maxPdfPages: num(env, "MAX_PDF_PAGES", 2000, 1),
    maxGifSeconds: num(env, "MAX_GIF_SECONDS", 60, 1),
    childMemLimitMb: num(env, "CHILD_MEM_LIMIT_MB", 2048),
    timeoutScale: num(env, "TIMEOUT_SCALE", 1, 0.001),
    s3Bucket: env.S3_BUCKET_NAME ? env.S3_BUCKET_NAME : null,
    s3Region: env.AWS_REGION || "us-east-1",
    python: env.PYTHON || "python3",
    logLevel: (env.LOG_LEVEL as ServerConfig["logLevel"]) || "info",
    ...overrides,
  };
  return cfg;
}
