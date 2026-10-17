import path from "node:path";
import { JobError } from "../errors.js";
import { run, safeEnv } from "../proc.js";
import { REPO_ROOT } from "../config.js";
import { safeBaseName } from "../util.js";
import type { ProcCtx, ProcResult } from "./types.js";

const SCRIPT = path.join(REPO_ROOT, "server", "scripts", "font_convert.py");

export async function processFont(ctx: ProcCtx): Promise<ProcResult> {
  const input = ctx.inputs[0]!;
  const fmt = String(ctx.options.format);
  const name = `${safeBaseName(input.name, "font")}.${fmt}`;
  const out = path.join(ctx.outDir, name);
  const r = await run(ctx.cfg.python, ["-I", SCRIPT, input.path, out, fmt], { signal: ctx.signal, timeoutMs: 60_000 * ctx.cfg.timeoutScale, memLimitMb: ctx.cfg.childMemLimitMb, env: safeEnv() });
  if (r.code !== 0) throw new JobError(r.code === 3 ? `${input.name} isn't a valid font file` : `Font conversion failed: ${r.stderr.trim().split("\n").pop()?.slice(0, 160) ?? "unknown error"}`);
  return { outputs: [{ path: out, name }], meta: {} };
}
