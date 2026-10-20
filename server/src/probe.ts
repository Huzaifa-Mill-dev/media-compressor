import fs from "node:fs";
import path from "node:path";
import { run, safeEnv } from "./proc.js";

export interface Binaries {
  ffmpeg: boolean;
  ffprobe: boolean;
  gs: boolean;
  qpdf: boolean;
  soffice: boolean;
  fonttools: boolean;
  /** pdf2docx (+ PyMuPDF) importable by the configured python → pdf-to-docx. */
  pdf2docx: boolean;
  /** Path of prlimit if present (child address-space cap). */
  prlimit: string | null;
  /** HEIC/HEIF decoder CLI (libheif-examples) if present. */
  heifDec: string | null;
  /** `unshare -rn` works → LibreOffice runs without network access. */
  netIsolation: boolean;
  /**
   * LibreOffice may be offered: it needs network isolation (documents can fetch URLs, e.g. WEBSERVICE() or linked
   * images → SSRF to cloud metadata / internal services) unless the operator explicitly accepts the risk.
   */
  officeSafe: boolean;
  /** ffmpeg encoders that are available (libx264, libx265, libvpx-vp9, libsvtav1, libopus, ...). */
  encoders: Set<string>;
  versions: Record<string, string>;
}

function which(bin: string): string | null {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

async function ok(cmd: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await run(cmd, args, { timeoutMs, env: safeEnv() });
    return { ok: r.code === 0, out: r.stdout + r.stderr };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Probe the binaries every tool depends on. Runs once at startup. */
export async function probeBinaries(python = "python3", opts: { allowUnisolatedOffice?: boolean } = {}): Promise<Binaries> {
  const [ffmpeg, ffprobe, gs, qpdf, soffice, fonttools, pdf2docx, encs, unshare] = await Promise.all([
    which("ffmpeg") ? ok("ffmpeg", ["-hide_banner", "-version"]) : { ok: false, out: "" },
    which("ffprobe") ? ok("ffprobe", ["-hide_banner", "-version"]) : { ok: false, out: "" },
    which("gs") ? ok("gs", ["--version"]) : { ok: false, out: "" },
    which("qpdf") ? ok("qpdf", ["--version"]) : { ok: false, out: "" },
    which("soffice") ? ok("soffice", ["--version"], 60_000) : { ok: false, out: "" },
    ok(python, ["-I", "-c", "import fontTools, brotli; print(fontTools.version)"]),
    ok(python, ["-I", "-W", "ignore", "-c", "import pymupdf, pdf2docx; print(pymupdf.VersionBind)"], 30_000),
    which("ffmpeg") ? ok("ffmpeg", ["-hide_banner", "-encoders"]) : { ok: false, out: "" },
    which("unshare") ? ok("unshare", ["-rn", "true"], 5_000) : { ok: false, out: "" },
  ]);
  const encoders = new Set<string>();
  if (encs.ok) {
    for (const line of encs.out.split("\n")) {
      const m = /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(line);
      if (m) encoders.add(m[1]!);
    }
  }
  const first = (s: string) => s.split("\n")[0]?.trim().slice(0, 120) ?? "";
  return {
    ffmpeg: ffmpeg.ok,
    ffprobe: ffprobe.ok,
    gs: gs.ok,
    qpdf: qpdf.ok,
    soffice: soffice.ok,
    fonttools: fonttools.ok,
    pdf2docx: pdf2docx.ok,
    prlimit: which("prlimit"),
    heifDec: which("heif-dec") ?? which("heif-convert"),
    netIsolation: unshare.ok,
    officeSafe: unshare.ok || opts.allowUnisolatedOffice === true,
    encoders,
    versions: {
      ffmpeg: first(ffmpeg.out),
      gs: first(gs.out),
      qpdf: first(qpdf.out),
      soffice: first(soffice.out),
      fonttools: first(fonttools.out),
      pdf2docx: first(pdf2docx.out),
    },
  };
}
