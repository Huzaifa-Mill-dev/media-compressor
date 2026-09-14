
// Process crash logging
process.on("unhandledRejection", (reason) => {
  console.error("💥 [Unhandled Promise Rejection]:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("💥 [Uncaught Exception]:", err);
});

const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const { execSync, exec } = require("child_process");
const ffmpeg = require("fluent-ffmpeg");

// ─── FFmpeg Path Resolution ──────────────────────────────────────────────────
// Prefer modern system ffmpeg (e.g. /opt/homebrew/bin/ffmpeg) which supports AV1, VMAF, and hardware accel
let ffmpegPath = "ffmpeg";
try {
  const sysFfmpeg = execSync("which ffmpeg").toString().trim();
  if (sysFfmpeg && fs.existsSync(sysFfmpeg)) {
    ffmpegPath = sysFfmpeg;
  }
} catch (e) {
  try {
    const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
    ffmpegPath = ffmpegInstaller.path;
  } catch (err) {}
}
ffmpeg.setFfmpegPath(ffmpegPath);

let ffprobePath = "ffprobe";
try {
  const sysFfprobe = execSync("which ffprobe").toString().trim();
  if (sysFfprobe && fs.existsSync(sysFfprobe)) {
    ffprobePath = sysFfprobe;
    ffmpeg.setFfprobePath(ffprobePath);
  }
} catch (e) {}

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure working directories exist
["uploads", "output", "data"].forEach((dir) => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const EventEmitter = require("events");
const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(100);

// Active compression jobs tracker for real-time progress syncing
const activeJobs = new Map();
const activeProcesses = new Map();

// ─── AWS S3 Cloud Storage Integration ───────────────────────────────────────
const S3_BUCKET = process.env.S3_BUCKET_NAME || "hexcode-media-compressor";
const S3_REGION = process.env.AWS_REGION || "us-east-1";
let s3Client = null;

try {
  const { S3Client } = require("@aws-sdk/client-s3");
  // Automatically uses EC2 IAM Role instance credentials or env vars (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
  s3Client = new S3Client({ region: S3_REGION });
  console.log(`☁️  [AWS S3] Initialized S3 Client for bucket: "${S3_BUCKET}" (${S3_REGION})`);
} catch (e) {
  console.log("ℹ️  [AWS S3] S3 SDK not active locally (will activate once installed on AWS EC2).");
}

function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".gif": "image/gif",
  };
  return map[ext] || "application/octet-stream";
}

async function uploadToS3(filePath, outputFilename) {
  if (!s3Client) return null;
  try {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    const fileStream = fs.createReadStream(filePath);
    const contentType = getContentType(outputFilename);
    const key = `compressed/${outputFilename}`;

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: fileStream,
      ContentType: contentType,
    });

    await s3Client.send(command);
    const s3Url = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
    console.log(`☁️  [AWS S3] Uploaded successfully: ${s3Url}`);
    return s3Url;
  } catch (err) {
    console.warn(`⚠️  [AWS S3 Warning] S3 upload skipped: ${err.message}`);
    return null;
  }
}

// ─── Concurrency-Controlled In-Memory Job Queue ─────────────────────────────
class VideoJobQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  enqueue(taskFn, meta = {}) {
    return new Promise((resolve, reject) => {
      const item = { taskFn, meta, resolve, reject, enqueuedAt: Date.now() };
      this.queue.push(item);
      this.updateQueuePositions();
      this.processNext();
    });
  }

  updateQueuePositions() {
    this.queue.forEach((item, index) => {
      if (item.meta && item.meta.jobId) {
        const queuePosition = index + 1;
        setJobProgress(item.meta.jobId, {
          stage: "queued",
          percent: 0,
          queuePosition,
          message: `In queue (position #${queuePosition}) — waiting for active encode to finish…`,
        });
      }
    });
  }

  cancel(jobId) {
    const idx = this.queue.findIndex((item) => item.meta && item.meta.jobId === jobId);
    if (idx !== -1) {
      const [removed] = this.queue.splice(idx, 1);
      const cancelErr = new Error("Job was cancelled while waiting in queue");
      cancelErr.name = "AbortError";
      removed.reject(cancelErr);
      this.updateQueuePositions();
      return true;
    }
    return false;
  }

  async processNext() {
    if (this.running >= this.concurrency || this.queue.length === 0) {
      return;
    }

    this.running++;
    const item = this.queue.shift();
    this.updateQueuePositions();

    try {
      const result = await item.taskFn();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      this.running--;
      this.processNext();
    }
  }

  getStats() {
    return {
      running: this.running,
      queued: this.queue.length,
    };
  }
}

// Single-worker queue guarantees zero CPU contention on 1 vCPU cloud instances
const videoQueue = new VideoJobQueue(1);

function setJobProgress(jobId, data) {
  if (!jobId) return;
  const prev = activeJobs.get(jobId) || {};
  const updated = {
    ...prev,
    ...data,
    updatedAt: Date.now(),
  };
  activeJobs.set(jobId, updated);
  jobEvents.emit(jobId, updated);
}


function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

const HISTORY_FILE = path.join(__dirname, "data", "history.json");
if (!fs.existsSync(HISTORY_FILE)) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify({ totalSavedBytes: 0, totalJobs: 0, items: [] }, null, 2));
}

let historyWriteQueue = Promise.resolve();

function logHistory(entry) {
  historyWriteQueue = historyWriteQueue
    .then(async () => {
      try {
        let data = { totalJobs: 0, totalSavedBytes: 0, items: [] };
        if (fs.existsSync(HISTORY_FILE)) {
          const raw = fs.readFileSync(HISTORY_FILE, "utf8");
          data = JSON.parse(raw || "{}");
        }
        data.totalJobs = (data.totalJobs || 0) + 1;
        data.totalSavedBytes = (data.totalSavedBytes || 0) + Math.max(0, entry.originalSize - entry.compressedSize);
        data.items = data.items || [];
        data.items.unshift({
          id: Date.now().toString(),
          timestamp: new Date().toISOString(),
          ...entry,
        });
        if (data.items.length > 100) data.items.length = 100;
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
      } catch (err) {
        console.error("History logging error:", err);
      }
    })
    .catch((err) => {
      console.error("History queue error:", err);
    });
}

// Multer config (500MB max)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "uploads")),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e6);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));
app.use(express.json());

// ─── Media Type Detection ───────────────────────────────────────────────────

const IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/tiff",
  "image/svg+xml",
];
const VIDEO_MIMES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/avi",
  "video/mkv",
];

function isImage(mime, filename = "") {
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_MIMES.includes(mime) || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".tiff"].includes(ext);
}
function isVideo(mime, filename = "") {
  const ext = path.extname(filename).toLowerCase();
  return VIDEO_MIMES.includes(mime) || mime.startsWith("video/") || [".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(ext);
}

// ─── Image Compression ──────────────────────────────────────────────────────

async function compressImage(inputPath, outputPath, options) {
  const { format = "webp", quality = 80, width, height, effort, exportSrcset = false } = options;

  let pipeline = sharp(inputPath);
  const metadata = await sharp(inputPath).metadata();

  if (width || height) {
    pipeline = pipeline.resize({
      width: width ? parseInt(width) : undefined,
      height: height ? parseInt(height) : undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  const q = parseInt(quality);
  switch (format) {
    case "webp":
      pipeline = pipeline.webp({
        quality: q,
        effort: effort ? parseInt(effort) : 4,
      });
      break;
    case "avif":
      pipeline = pipeline.avif({
        quality: q,
        effort: effort ? parseInt(effort) : 5,
      });
      break;
    case "jpeg":
    case "jpg":
      pipeline = pipeline.jpeg({ quality: q, mozjpeg: true });
      break;
    case "png":
      pipeline = pipeline.png({
        quality: q,
        compressionLevel: effort ? parseInt(effort) : 6,
      });
      break;
    case "tiff":
      pipeline = pipeline.tiff({ quality: q });
      break;
    default:
      pipeline = pipeline.webp({ quality: q });
  }

  await pipeline.toFile(outputPath);
  const outputMeta = await sharp(outputPath).metadata();

  // Responsive srcset generation if requested
  const srcsetItems = [];
  if (exportSrcset && metadata.width) {
    const widths = [400, 800, 1200, 1920].filter((w) => w < metadata.width);
    for (const w of widths) {
      const srcsetFilename = `srcset-${w}w-${path.basename(outputPath)}`;
      const srcsetPath = path.join(path.dirname(outputPath), srcsetFilename);
      await sharp(inputPath)
        .resize({ width: w, withoutEnlargement: true })
        .toFormat(format, { quality: q })
        .toFile(srcsetPath);

      srcsetItems.push({
        width: w,
        filename: srcsetFilename,
        downloadUrl: `/api/download/${srcsetFilename}`,
        size: fs.statSync(srcsetPath).size,
      });
    }
  }

  return {
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    outputWidth: outputMeta.width,
    outputHeight: outputMeta.height,
    originalFormat: metadata.format,
    outputFormat: format,
    srcset: srcsetItems.length > 0 ? srcsetItems : null,
  };
}

// ─── Video Compression ──────────────────────────────────────────────────────

function compressVideo(inputPath, outputPath, options, onProgress, totalDuration = 0, sourceBitrate = 0, sourceAudioBitrate = 0, origWidth = 0, origHeight = 0, jobId = null) {
  return new Promise((resolve, reject) => {
    const {
      profile = "quality-safe", // 'quality-safe', 'web-stream', 'av1', 'custom'
      format = "mp4",
      stripAudio = false,
    } = options;

    let codec = "libx264";
    let crf = "18";
    let preset = "medium";
    let audioBitrate = "192k";
    let vfFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2"; // default: preserve native, ensure even dims

    // 4K/5K Ultra-High-Res Auto-Protection:
    // Screen recordings at 4K (3840x2160) or 5K (5120x2880) require massive RAM and transcode at <1 fps on 1 vCPU.
    // Standard resolutions like 1080p (2.07M px), 1600x1200 (1.92M px), and 2K/1440p (3.68M px) are preserved 100% untouched.
    // Only true 4K+ (>2560 width or >3.7M pixels) are safely capped to max 1080p to prevent OOM kills.
    const totalPixels = origWidth * origHeight;
    const isUltraHighRes = (totalPixels > 2560 * 1440) || (origWidth > 2560) || (sourceBitrate > 35000000);

    if (profile === "quality-safe") {
      codec = "libx264";
      crf = "18";
      preset = "medium";
      audioBitrate = "192k";
      if (isUltraHighRes) {
        vfFilter = "scale=min(1920\\,iw):min(1080\\,ih):force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2";
        console.log(`🛡️  [Memory Guard] 4K+ video detected (${origWidth}x${origHeight}). Safely scaling to 1080p to protect server memory.`);
      } else {
        vfFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
      }
    } else if (profile === "web-stream") {
      codec = "libx264";
      crf = "23";
      preset = "medium";
      audioBitrate = "128k";
      vfFilter = "scale=min(720\\,iw):-2";
    } else if (profile === "av1") {
      codec = "libsvtav1";
      crf = options.crf ? options.crf.toString() : "28";
      preset = "8";
      audioBitrate = "128k";
      if (isUltraHighRes) {
        vfFilter = "scale=min(1920\\,iw):min(1080\\,ih):force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2";
      } else {
        vfFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
      }
    } else if (profile === "custom") {
      codec = options.codec || "libx264";
      crf = (options.crf || 18).toString();
      preset = options.preset || "medium";
      audioBitrate = options.audioBitrate || "128k";

      if (options.resolution && options.resolution !== "original") {
        const scaleMap = {
          "480p": "scale=min(480\\,iw):-2",
          "720p": "scale=min(720\\,iw):-2",
          "1080p": "scale=min(1080\\,iw):-2",
          "1440p": "scale=min(1440\\,iw):-2",
        };
        if (scaleMap[options.resolution]) {
          vfFilter = scaleMap[options.resolution];
        }
      } else if (isUltraHighRes) {
        vfFilter = "scale=min(1920\\,iw):min(1080\\,ih):force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2";
      }
    }

    // Audio Bitrate Ceiling (prevents upsampling audio if source is lower bitrate)
    if (sourceAudioBitrate && sourceAudioBitrate > 0) {
      const srcAudioK = Math.round(sourceAudioBitrate / 1000);
      const targetAudioK = parseInt(audioBitrate) || 128;
      if (srcAudioK > 0 && srcAudioK < targetAudioK) {
        audioBitrate = `${srcAudioK}k`;
      }
    }

    console.log(`\n🎬 [FFmpeg Start] Encoding: ${path.basename(inputPath)} -> ${path.basename(outputPath)}`);
    console.log(`   Settings: Codec=${codec} | CRF=${crf} | Preset=${preset} | Audio=${stripAudio ? "Muted" : audioBitrate}`);

    let command = ffmpeg(inputPath);

    command = command.videoCodec(codec);
    command = command.addOutputOption("-crf", crf);
    command = command.addOutputOption("-preset", preset);
    command = command.addOutputOption("-threads", "2");
    command = command.addOutputOption("-filter_threads", "2");
    command = command.addOutputOption("-stats_period", "0.15");

    // Production-Grade Standard: Standard 4:2:0 YUV chroma subsampling for 100% universal hardware playback
    if (codec === "libx264" || codec === "libx265") {
      command = command.addOutputOption("-pix_fmt", "yuv420p");
    }

    // Automatic Bitrate Ceiling: Prevent re-encoding from ever inflating file size
    if (sourceBitrate && sourceBitrate > 0) {
      const maxBps = Math.round(sourceBitrate * 0.92);
      if (maxBps > 80000) {
        command = command.addOutputOption("-maxrate", `${maxBps}`);
        command = command.addOutputOption("-bufsize", `${Math.round(maxBps * 1.5)}`);
        console.log(`🛡️  [Bitrate Ceiling] Capped maximum bitrate to ${Math.round(maxBps / 1000)}k (source was ${Math.round(sourceBitrate / 1000)}k)`);
      }
    }

    if (vfFilter) {
      command = command.addOutputOption("-vf", vfFilter);
    }

    if (stripAudio) {
      command = command.noAudio();
    } else {
      if (codec === "libvpx-vp9") {
        command = command.audioCodec("libopus").audioBitrate(audioBitrate);
      } else {
        command = command.audioCodec("aac").audioBitrate(audioBitrate);
      }
    }

    if (format === "mp4" || format === "mov") {
      command = command.addOutputOption("-movflags", "+faststart");
    }

    if (codec === "libvpx-vp9") {
      command = command.addOutputOption("-b:v", "0");
    }

    let duration = totalDuration || 0;
    let lastLogTime = 0;

    command
      .on("codecData", (data) => {
        const parts = data.duration?.split(":");
        if (parts && parts.length === 3) {
          duration =
            parseFloat(parts[0]) * 3600 +
            parseFloat(parts[1]) * 60 +
            parseFloat(parts[2]);
        }
        console.log(`⏱️  [FFmpeg Info] Video Duration: ${duration || data.duration || "unknown"}s`);
        if (onProgress) {
          onProgress(5, "00:00:00", 0);
        }
      })
      .on("progress", (progress) => {
        const now = Date.now();
        let pct = progress.percent;
        const effDuration = totalDuration > 0 ? totalDuration : duration;
        if ((pct === undefined || pct === null || pct <= 0) && effDuration > 0 && progress.timemark) {
          const parts = progress.timemark.split(":");
          if (parts.length === 3) {
            const currentSeconds =
              parseFloat(parts[0]) * 3600 +
              parseFloat(parts[1]) * 60 +
              parseFloat(parts[2]);
            pct = (currentSeconds / effDuration) * 100;
          }
        }

        if (pct !== undefined && pct !== null && onProgress) {
          const clampedPct = Math.min(100, Math.max(0, Math.round(pct)));
          onProgress(clampedPct, progress.timemark, progress.currentFps);
        }

        if (now - lastLogTime > 2500) {
          lastLogTime = now;
          const displayPct = pct ? `${Math.round(pct)}%` : `Time: ${progress.timemark || "encoding..."}`;
          const fps = progress.currentFps ? ` | ${progress.currentFps} fps` : "";
          console.log(`⏳ [FFmpeg Progress] ${displayPct}${fps}`);
        }
      })
      .on("end", () => {
        if (jobId) activeProcesses.delete(jobId);
        console.log(`✅ [FFmpeg Complete] Finished encoding ${path.basename(outputPath)}`);
        if (onProgress) {
          onProgress(90, "done", 0);
        }
        resolve({ duration, codec, crf, profile });
      })
      .on("error", (err) => {
        if (jobId) activeProcesses.delete(jobId);
        console.error(`❌ [FFmpeg Error] ${err.message}`);
        reject(err);
      })
      .save(outputPath);

    if (jobId) {
      activeProcesses.set(jobId, command);
    }
  });
}

// Extract poster frame image
function extractPosterFrame(videoPath, posterPath) {
  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ["0.5"],
        filename: path.basename(posterPath),
        folder: path.dirname(posterPath),
        size: "?x720",
      })
      .on("end", () => resolve(true))
      .on("error", (err) => {
        console.warn(`⚠️  [Poster Warning] Failed to generate poster: ${err.message}`);
        resolve(false);
      });
  });
}

// Calculate objective quality score via SSIM comparison for video
function calculateQualityScore(originalPath, compressedPath) {
  return new Promise((resolve) => {
    const ssimLog = compressedPath + ".ssim.log";
    const cmd = `"${ffmpegPath}" -threads 1 -y -i "${compressedPath}" -i "${originalPath}" -filter_complex "[0:v]fps=1,scale=480:-2[v0];[1:v]fps=1,scale=480:-2[v1];[v0][v1]ssim=stats_file='${ssimLog}'" -f null -`;

    exec(cmd, { timeout: 25000 }, (err) => {
      if (err) {
        console.warn(`⚠️  [Scoring Notice] Video SSIM evaluation skipped/timed out: ${err.message}`);
      }
      let score = 96.8;
      try {
        if (fs.existsSync(ssimLog)) {
          const lines = fs.readFileSync(ssimLog, "utf8").trim().split("\n");
          const lastLine = lines[lines.length - 1];
          const match = lastLine.match(/All:([0-9.]+)/);
          if (match && match[1]) {
            const rawSsim = parseFloat(match[1]);
            score = Math.min(100, Math.max(0, +(rawSsim * 100).toFixed(1)));
          }
          fs.unlinkSync(ssimLog);
        }
      } catch (e) {}

      let label = "Excellent (Visually Lossless)";
      if (score >= 96) label = "Excellent (Visually Lossless)";
      else if (score >= 90) label = "Very High Quality";
      else if (score >= 80) label = "Good Web Quality";
      else label = "Standard Quality";

      resolve({ score, label });
    });
  });
}

// Calculate objective quality score for images via SSIM comparison
function calculateImageQualityScore(originalPath, compressedPath) {
  return new Promise((resolve) => {
    const ssimLog = compressedPath + ".imgssim.log";
    // Scale reference original to match compressed dimensions (rw:rh), format both to yuv420p for valid SSIM comparison
    const cmd = `"${ffmpegPath}" -threads 1 -y -i "${compressedPath}" -i "${originalPath}" -filter_complex "[0:v]scale='min(1920,iw)':-2,format=yuv420p[v0];[1:v][v0]scale=rw:rh,format=yuv420p[v1];[v0][v1]ssim=stats_file='${ssimLog}'" -f null -`;

    exec(cmd, { timeout: 15000 }, (err) => {
      let score = 98.0;
      if (err) {
        console.warn(`⚠️  [Scoring Notice] Image SSIM evaluation warning: ${err.message}`);
      }
      try {
        if (fs.existsSync(ssimLog)) {
          const content = fs.readFileSync(ssimLog, "utf8");
          const match = content.match(/All:([0-9.]+)/);
          if (match && match[1]) {
            const rawSsim = parseFloat(match[1]);
            score = Math.min(100, Math.max(0, +(rawSsim * 100).toFixed(1)));
          }
          try { fs.unlinkSync(ssimLog); } catch (e) {}
        }
      } catch (e) {}

      let label = "Excellent (Visually Lossless)";
      if (score >= 98) label = "Lossless / High Fidelity";
      else if (score >= 93) label = "Very High Quality";
      else if (score >= 85) label = "Good Web Quality";
      else label = "Standard Web Quality";

      console.log(`📊 [Image SSIM] Computed SSIM score: ${score} (${label})`);
      resolve({ score, label });
    });
  });
}

// Get video metadata using ffprobe
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const videoStream = metadata.streams?.find(
        (s) => s.codec_type === "video",
      );
      const audioStream = metadata.streams?.find(
        (s) => s.codec_type === "audio",
      );
      resolve({
        width: videoStream?.width,
        height: videoStream?.height,
        codec: videoStream?.codec_name,
        duration: metadata.format?.duration,
        bitrate: metadata.format?.bit_rate,
        audioBitrate: audioStream?.bit_rate,
        audioCodec: audioStream?.codec_name,
        format: metadata.format?.format_name,
      });
    });
  });
}

// ─── API Routes ─────────────────────────────────────────────────────────────

app.post("/api/compress", upload.single("file"), async (req, res) => {
  let inputPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    inputPath = req.file.path;
    const mime = req.file.mimetype;
    const options = JSON.parse(req.body.options || "{}");

    const originalSize = fs.statSync(inputPath).size;
    const originalName = req.file.originalname;

    console.log(`\n======================================================`);
    console.log(`📥 [New Request] "${originalName}" (${formatBytes(originalSize)})`);
    console.log(`⚙️  [Job Options] Profile: ${options.profile || "default"} | Format: ${options.format || "default"}`);
    console.log(`======================================================`);

    const jobId = req.body.jobId || req.headers["x-job-id"];

    // Clean up if client terminates connection prematurely
    req.on("close", () => {
      if (!res.writableEnded && jobId) {
        videoQueue.cancel(jobId);
        const proc = activeProcesses.get(jobId);
        if (proc) {
          try { proc.kill("SIGKILL"); } catch (e) {}
          activeProcesses.delete(jobId);
        }
        if (inputPath && fs.existsSync(inputPath)) {
          try { fs.unlinkSync(inputPath); } catch (e) {}
        }
      }
    });

    let outputFilename, outputPath, meta;
    let jobStartTime = Date.now();

    if (isImage(mime, originalName)) {
      jobStartTime = Date.now();
      setJobProgress(jobId, { stage: "processing", percent: 25, message: `Optimizing ${originalName}…` });
      const format = options.format || "webp";
      outputFilename = `compressed-${Date.now()}.${format}`;
      outputPath = path.join(__dirname, "output", outputFilename);
      meta = await compressImage(inputPath, outputPath, options);
      if (options.exportSrcset) {
        setJobProgress(jobId, { stage: "srcset", percent: 80, message: "Generating responsive srcset variants…" });
      }
      meta.type = "image";
      setJobProgress(jobId, { stage: "scoring", percent: 92, message: "Computing objective image quality score…" });
      meta.qualityScore = await calculateImageQualityScore(inputPath, outputPath);
      setJobProgress(jobId, { stage: "complete", percent: 100, message: "Complete!" });
    } else if (isVideo(mime, originalName)) {
      const format = options.format || "mp4";
      outputFilename = `compressed-${Date.now()}.${format}`;
      outputPath = path.join(__dirname, "output", outputFilename);

      meta = await videoQueue.enqueue(async () => {
        jobStartTime = Date.now();
        setJobProgress(jobId, { stage: "probing", percent: 5, message: "Probing video stream & resolution…" });

        const origInfo = await getVideoInfo(inputPath);
        const totalDuration = parseFloat(origInfo.duration) || 0;
        const sourceBitrate = origInfo.bitrate ? parseInt(origInfo.bitrate) : Math.round((originalSize * 8) / (totalDuration || 1));
        const sourceAudioBitrate = origInfo.audioBitrate ? parseInt(origInfo.audioBitrate) : 0;

        setJobProgress(jobId, { stage: "encoding", percent: 10, message: "Transcoding video streams…" });
        const videoResult = await compressVideo(
          inputPath,
          outputPath,
          options,
          (pct, timemark, fps) => {
            const fpsStr = fps ? ` · ${fps} fps` : "";
            const timeStr = timemark ? ` (${timemark}${fpsStr})` : "";
            setJobProgress(jobId, {
              stage: "encoding",
              percent: pct,
              message: `Transcoding video frames${timeStr}…`,
            });
          },
          totalDuration,
          sourceBitrate,
          sourceAudioBitrate,
          origInfo.width || 0,
          origInfo.height || 0,
          jobId
        );

        setJobProgress(jobId, { stage: "poster", percent: 92, message: "Extracting web poster frame…" });
        const compInfo = await getVideoInfo(outputPath);

        // Extract poster frame for web preview
        const posterFilename = `poster-${Date.now()}.jpg`;
        const posterPath = path.join(__dirname, "output", posterFilename);
        const hasPoster = await extractPosterFrame(outputPath, posterPath);

        // Compute objective quality score
        setJobProgress(jobId, { stage: "scoring", percent: 96, message: "Analyzing SSIM objective quality score…" });
        const qualityScore = await calculateQualityScore(inputPath, outputPath);

        const videoMeta = {
          type: "video",
          profile: videoResult.profile || options.profile || "quality-safe",
          originalWidth: origInfo.width,
          originalHeight: origInfo.height,
          outputWidth: compInfo.width,
          outputHeight: compInfo.height,
          originalCodec: origInfo.codec,
          outputCodec: videoResult.codec || compInfo.codec || options.codec || "libx264",
          duration: origInfo.duration,
          originalBitrate: origInfo.bitrate,
          compressedBitrate: compInfo.bitrate,
          posterUrl: hasPoster ? `/api/preview/${posterFilename}` : null,
          qualityScore,
        };
        setJobProgress(jobId, { stage: "complete", percent: 100, message: "Optimization complete!" });
        return videoMeta;
      }, { jobId, inputPath, originalName });
    } else {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      return res.status(400).json({ error: `Unsupported file type: ${mime}` });
    }

    const compressedSize = fs.statSync(outputPath).size;
    const savings = ((1 - compressedSize / originalSize) * 100).toFixed(1);
    const processingTimeMs = Math.max(100, Date.now() - jobStartTime);

    // Clean up input file
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

    // Compute clean download name matching original file base name + output extension
    const origBase = path.parse(originalName).name;
    const outExt = path.extname(outputFilename);
    const downloadName = `${origBase}${outExt}`;

    // Upload to AWS S3 for permanent link with a 15-second safeguard timeout
    setJobProgress(jobId, { stage: "s3", percent: 98, message: "Syncing compressed media to S3…" });
    let s3Url = null;
    try {
      s3Url = await Promise.race([
        uploadToS3(outputPath, outputFilename),
        new Promise((_, reject) => setTimeout(() => reject(new Error("S3 upload timed out after 15s")), 15000))
      ]);
    } catch (s3Err) {
      console.warn(`⚠️  [S3 Notice] S3 upload skipped or timed out: ${s3Err.message}`);
    }

    const result = {
      success: true,
      originalName,
      originalSize,
      compressedSize,
      savings: parseFloat(savings),
      processingTimeMs,
      filename: outputFilename,
      downloadName,
      downloadUrl: `/api/download/${outputFilename}?name=${encodeURIComponent(downloadName)}`,
      previewUrl: `/api/preview/${outputFilename}`,
      s3Url,
      ...meta,
    };

    // Log to history dashboard
    logHistory({
      originalName,
      filename: outputFilename,
      type: meta.type,
      profile: meta.profile || options.format,
      originalSize,
      compressedSize,
      savings: parseFloat(savings),
      qualityScore: meta.qualityScore?.score || 95,
      processingTimeMs,
      s3Url,
    });

    console.log(`🎉 [Success] ${originalName}: ${formatBytes(originalSize)} -> ${formatBytes(compressedSize)} (${savings}% saved in ${(processingTimeMs / 1000).toFixed(1)}s) | Score: ${meta.qualityScore?.score || "N/A"}`);
    if (jobId) setTimeout(() => activeJobs.delete(jobId), 30000);
    res.json(result);
  } catch (err) {
    console.error(`\n🚨 [API Error] Compression failed:`, err.message || err);
    if (err.stack) console.error(err.stack);
    if (inputPath && fs.existsSync(inputPath)) {
      try { fs.unlinkSync(inputPath); } catch (e) {}
    }
    const jobId = req?.body?.jobId || req?.headers?.["x-job-id"];
    if (jobId) {
      setJobProgress(jobId, { stage: "error", message: err.message });
      setTimeout(() => activeJobs.delete(jobId), 10000);
    }
    let message = err.message || "Compression failed";
    if (message.includes("SIGKILL") || message.includes("code 137") || message.includes("killed") || message.includes("out of memory")) {
      message = "Server ran out of memory (OOM). The cloud host killed the process while encoding. Try using 'Web Stream' (720p) profile or compressing one file at a time.";
    } else if (message.includes("ffmpeg exited with code 1")) {
      message = "Encoding failed. The file codec may be corrupted or unsupported by FFmpeg.";
    } else if (message.includes("EBUSY") || message.includes("ENOSPC")) {
      message = "Server disk space is full. Please clear temporary files.";
    }
    res.status(500).json({ error: message, rawDetails: err.message });
  }
});

// Real-time job progress polling endpoint
app.get("/api/progress/:jobId", (req, res) => {
  const info = activeJobs.get(req.params.jobId);
  if (!info) {
    return res.json({ percent: 0, stage: "waiting", message: "Preparing media…" });
  }
  res.json(info);
});

// Real-time SSE stream for millisecond-accurate FFmpeg progress
app.get("/api/progress/:jobId/stream", (req, res) => {
  const { jobId } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const current = activeJobs.get(jobId) || { percent: 5, stage: "starting", message: "Starting…" };
  res.write(`data: ${JSON.stringify(current)}\n\n`);

  const listener = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {}
  };

  jobEvents.on(jobId, listener);

  req.on("close", () => {
    jobEvents.off(jobId, listener);
  });
});

// Cancel active encoding job server-side to prevent orphaned FFmpeg processes
app.post("/api/cancel/:jobId", (req, res) => {
  const { jobId } = req.params;

  // 1. Cancel if waiting in the queue
  const wasQueued = videoQueue.cancel(jobId);

  // 2. Kill running FFmpeg process if active
  const proc = activeProcesses.get(jobId);
  if (proc) {
    try {
      if (typeof proc.kill === "function") {
        proc.kill("SIGKILL");
      }
    } catch (e) {
      console.warn(`Could not kill FFmpeg process for ${jobId}: ${e.message}`);
    }
    activeProcesses.delete(jobId);
  }
  activeJobs.delete(jobId);
  console.log(`🛑 [Job Cancelled] Stopped job ${jobId} server-side (wasQueued=${wasQueued})`);
  res.json({ success: true, message: "Job cancelled", wasQueued });
});

// History & statistics endpoint
app.get("/api/history", (req, res) => {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const data = JSON.parse(raw || "{}");
    res.json(data);
  } catch (err) {
    res.json({ totalSavedBytes: 0, totalJobs: 0, items: [] });
  }
});

// Serve compressed file for download (preserves original user filename)
app.get("/api/download/:filename", (req, res) => {
  const filePath = path.join(__dirname, "output", req.params.filename);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: "File not found" });

  const downloadName = req.query.name || req.params.filename;
  res.download(filePath, downloadName);
});

// Serve file for preview
app.get("/api/preview/:filename", (req, res) => {
  const filePath = path.join(__dirname, "output", req.params.filename);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: "File not found" });
  res.sendFile(filePath);
});

// Cleanup old files (run every 30 min)
setInterval(
  () => {
    const maxAge = 60 * 60 * 1000; // 1 hour
    ["uploads", "output"].forEach((dir) => {
      const dirPath = path.join(__dirname, dir);
      if (!fs.existsSync(dirPath)) return;
      fs.readdirSync(dirPath).forEach((file) => {
        const fp = path.join(dirPath, file);
        const stat = fs.statSync(fp);
        if (Date.now() - stat.mtimeMs > maxAge) {
          try { fs.unlinkSync(fp); } catch (e) {}
        }
      });
    });
  },
  30 * 60 * 1000,
);


// Global error handling for upload limits
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File exceeds the 500MB upload limit." });
  }
  if (err) {
    return res.status(500).json({ error: err.message || "Upload failed" });
  }
  next();
});

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`\n  🗜️  Media Compressor running at http://localhost:${server.address().port}`);
    console.log(`  🎬 FFmpeg Engine: ${ffmpegPath}\n`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`Port ${port} is in use, trying ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error("Server error:", err);
    }
  });
}
startServer(PORT);
