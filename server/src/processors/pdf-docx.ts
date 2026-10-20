import path from "node:path";
import { JobError } from "../errors.js";
import { run, safeEnv } from "../proc.js";
import { REPO_ROOT } from "../config.js";
import { safeBaseName } from "../util.js";
import type { ProcCtx, ProcResult } from "./types.js";

const SCRIPT = path.join(REPO_ROOT, "server", "scripts", "pdf_to_docx.py");

/** PDF → editable DOCX with pdf2docx (layout analysis → real paragraphs/tables), see scripts/pdf_to_docx.py. */
export async function pdfToDocx(ctx: ProcCtx): Promise<ProcResult> {
  const input = ctx.inputs[0]!;
  const name = `${safeBaseName(input.name, "document")}.docx`;
  const out = path.join(ctx.outDir, name);
  ctx.progress(5, "Analysing layout");
  let buf = "";
  const r = await run(ctx.cfg.python, ["-I", "-W", "ignore", SCRIPT, input.path, out, String(ctx.cfg.maxPdfPages)], {
    signal: ctx.signal,
    timeoutMs: 600_000 * ctx.cfg.timeoutScale,
    // PyMuPDF maps little address space, so the prlimit cap is safe; the RSS watchdog catches runaway layouts.
    memLimitMb: ctx.cfg.childMemLimitMb,
    rssLimitMb: 900,
    env: safeEnv(),
    onStdout: (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        const m = /^P (\d+)$/.exec(l.trim());
        if (m) ctx.progress(Number(m[1]), "Rebuilding pages");
      }
    },
  });
  switch (r.code) {
    case 0:
      break;
    case 3:
      throw new JobError(`${input.name} isn't a readable PDF`);
    case 4:
      throw new JobError(`${input.name} is password-protected`);
    case 5:
      throw new JobError(`${input.name} has more than ${ctx.cfg.maxPdfPages} pages`);
    default:
      throw new JobError("This PDF couldn't be converted to Word (it may be damaged or use an unusual layout)");
  }
  let meta: { pages?: number; scanned?: boolean } = {};
  try {
    meta = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    /* output exists; meta is optional */
  }
  return { outputs: [{ path: out, name }], meta };
}
