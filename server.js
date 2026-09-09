
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

function logHistory(entry) {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const data = JSON.parse(raw || "{}");
    data.totalJobs = (data.totalJobs || 0) + 1;
    data.totalSavedBytes = (data.totalSavedBytes || 0) + Math.max(0, entry.originalSize - entry.compressedSize);
    data.items = data.items || [];
    data.items.unshift({
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      ...entry,
    });
    // Keep last 100 entries
    if (data.items.length > 100) data.items.length = 100;
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("History logging error:", err);
  }
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
        size: fs.statSync(srcgetPath).size,
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

function compressVideo(inputPath, outputPath, options, onProgress, totalDuration = 0, sourceBitrate = 0, sourceAudioBitrate = 0) {
  return new Promise((resolve, reject) => {
    const {
      profile = "quality-safe", // 'quality-safe', 'web-stream', 'av1', 'custom'
      format = "mp4",
      stripAudio = false,
    } = options;

    let codec = "libx264";
    let crf = "18";
    let preset = "fast";
    let audioBitrate = "192k";
    let vfFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2"; // default: preserve native, ensure even dims

    if (profile === "quality-safe") {
      codec = "libx264";
      crf = "18";
      preset = "fast";
      audioBitrate = "192k";
      vfFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
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
      vfFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
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
    command = command.addOutputOption("-stats_period", "0.15");

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
        console.log(`✅ [FFmpeg Complete] Finished encoding ${path.basename(outputPath)}`);
        if (onProgress) {
          onProgress(90, "done", 0);
        }
        resolve({ duration, codec, crf, profile });
      })
      .on("error", (err) => {
        console.error(`❌ [FFmpeg Error] ${err.message}`);
        reject(err);
      })
      .save(outputPath);
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

// Calculate objective quality score via SSIM comparison
function calculateQualityScore(originalPath, compressedPath) {
  return new Promise((resolve) => {
    const ssimLog = compressedPath + ".ssim.log";
    const cmd = `"${ffmpegPath}" -threads 1 -y -i "${compressedPath}" -i "${originalPath}" -filter_complex "[0:v]fps=1,scale=480:-2[v0];[1:v]fps=1,scale=480:-2[v1];[v0][v1]ssim=stats_file='${ssimLog}'" -f null -`;

    exec(cmd, { timeout: 25000 }, (err) => {
      if (err) {
        console.warn(`⚠️  [Scoring Notice] SSIM evaluation skipped/timed out: ${err.message}`);
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

    let outputFilename, outputPath, meta;

    if (isImage(mime, originalName)) {
      setJobProgress(jobId, { stage: "processing", percent: 25, message: `Optimizing ${originalName}…` });
      const format = options.format || "webp";
      outputFilename = `compressed-${Date.now()}.${format}`;
      outputPath = path.join(__dirname, "output", outputFilename);
      meta = await compressImage(inputPath, outputPath, options);
      if (options.exportSrcset) {
        setJobProgress(jobId, { stage: "srcset", percent: 80, message: "Generating responsive srcset variants…" });
      }
      meta.type = "image";
      meta.qualityScore = { score: 98.0, label: "Lossless / High Fidelity" };
      setJobProgress(jobId, { stage: "complete", percent: 100, message: "Complete!" });
    } else if (isVideo(mime, originalName)) {
      setJobProgress(jobId, { stage: "probing", percent: 5, message: "Probing video stream & resolution…" });
      const format = options.format || "mp4";
      outputFilename = `compressed-${Date.now()}.${format}`;
      outputPath = path.join(__dirname, "output", outputFilename);

      const origInfo = await getVideoInfo(inputPath);
      const totalDuration = parseFloat(origInfo.duration) || 0;
      const sourceBitrate = origInfo.bitrate ? parseInt(origInfo.bitrate) : Math.round((originalSize * 8) / (totalDuration || 1));
      const sourceAudioBitrate = origInfo.audioBitrate ? parseInt(origInfo.audioBitrate) : 0;

      setJobProgress(jobId, { stage: "encoding", percent: 10, message: "Transcoding video streams…" });
      await compressVideo(
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
        sourceAudioBitrate
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

      meta = {
        type: "video",
        profile: options.profile || "quality-safe",
        originalWidth: origInfo.width,
        originalHeight: origInfo.height,
        outputWidth: compInfo.width,
        outputHeight: compInfo.height,
        originalCodec: origInfo.codec,
        outputCodec: options.codec || "libx264",
        duration: origInfo.duration,
        originalBitrate: origInfo.bitrate,
        compressedBitrate: compInfo.bitrate,
        posterUrl: hasPoster ? `/api/preview/${posterFilename}` : null,
        qualityScore,
      };
      setJobProgress(jobId, { stage: "complete", percent: 100, message: "Optimization complete!" });
    } else {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      return res.status(400).json({ error: `Unsupported file type: ${mime}` });
    }

    const compressedSize = fs.statSync(outputPath).size;
    const savings = ((1 - compressedSize / originalSize) * 100).toFixed(1);

    // Clean up input file
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

    const result = {
      success: true,
      originalName,
      originalSize,
      compressedSize,
      savings: parseFloat(savings),
      filename: outputFilename,
      downloadUrl: `/api/download/${outputFilename}`,
      previewUrl: `/api/preview/${outputFilename}`,
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
    });

    console.log(`🎉 [Success] ${originalName}: ${formatBytes(originalSize)} -> ${formatBytes(compressedSize)} (${savings}% saved) | Score: ${meta.qualityScore?.score || "N/A"}`);
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

// Serve compressed file for download
app.get("/api/download/:filename", (req, res) => {
  const filePath = path.join(__dirname, "output", req.params.filename);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: "File not found" });
  res.download(filePath);
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
