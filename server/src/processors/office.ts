import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JobError } from "../errors.js";
import { run, safeEnv } from "../proc.js";
import { safeBaseName } from "../util.js";
import type { ProcCtx, ProcResult } from "./types.js";

const DOC_FILTERS: Record<string, string> = {
  pdf: "pdf",
  docx: "docx:MS Word 2007 XML",
  odt: "odt",
  rtf: "rtf",
  txt: "txt:Text (encoded):UTF8",
  html: "html",
};
const SHEET_FILTERS = (all: boolean): Record<string, string> => ({
  csv: `csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,${all ? -1 : 0}`,
  xlsx: "xlsx:Calc MS Excel 2007 XML",
  ods: "ods",
  pdf: "pdf:calc_pdf_Export",
});

/** LibreOffice headless: isolated profile per job, no network (when unshare works), whole process group killed on cancel. */
export async function processOffice(ctx: ProcCtx): Promise<ProcResult> {
  const input = ctx.inputs[0]!;
  const isSheet = ctx.toolId === "spreadsheet-convert";
  const fmt = String(ctx.options.format);
  const filter = isSheet ? SHEET_FILTERS(ctx.options.sheets === "all")[fmt] : DOC_FILTERS[fmt];
  if (!filter) throw new JobError(`Conversion to .${fmt} isn't supported`);

  // Neutral input name: LibreOffice never sees the user's file name.
  const src = path.join(ctx.workDir, `input.${input.ext}`);
  await fs.copyFile(input.path, src);
  const profile = path.join(ctx.workDir, "lo-profile");
  const home = path.join(ctx.workDir, "home");
  await fs.mkdir(home, { recursive: true });
  const tmpOut = path.join(ctx.workDir, "lo-out");
  await fs.mkdir(tmpOut, { recursive: true });

  ctx.progress(10, "Converting");
  const r = await run(
    "soffice",
    [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo", "--nofirststartwizard", "--convert-to", filter, "--outdir", tmpOut, src],
    {
      signal: ctx.signal,
      timeoutMs: 240_000 * ctx.cfg.timeoutScale,
      memLimitMb: 0, // LibreOffice maps a lot of address space; the heavy queue (concurrency 1) is the guard
      rssLimitMb: 700,
      wrapper: ctx.bins.netIsolation ? ["unshare", "-rn"] : undefined,
      env: safeEnv({ HOME: home, SAL_USE_VCLPLUGIN: "svp" }),
    },
  );
  const produced = (await fs.readdir(tmpOut)).sort();
  if (r.code !== 0 || produced.length === 0) throw new JobError("This file couldn't be converted (it may be damaged, encrypted or unsupported)");

  const base = safeBaseName(input.name, "document");
  const outputs = [];
  for (const f of produced) {
    const ext = path.extname(f).slice(1) || fmt;
    // csv of all sheets → input-SheetName.csv; keep the sheet name part, sanitized
    const suffix = produced.length > 1 ? `-${safeBaseName(f.replace(/^input-?/, ""), "sheet")}` : "";
    const name = `${base}${suffix}.${ext}`.replace(/\.(csv|pdf|docx|odt|rtf|txt|html|xlsx|ods)\.\1$/, ".$1");
    await fs.rename(path.join(tmpOut, f), path.join(ctx.outDir, name));
    outputs.push({ path: path.join(ctx.outDir, name), name });
  }
  return { outputs, meta: {} };
}
