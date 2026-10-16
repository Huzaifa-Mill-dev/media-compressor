import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { AbortError, MemoryLimitError, TimeoutError } from "./errors.js";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Hard wall-clock limit; the whole process group is SIGKILLed when exceeded. */
  timeoutMs?: number;
  /**
   * Address-space cap in MB (via prlimit) — 0/undefined = none. NEVER use for SVT-AV1 (it maps far more
   * address space than it touches and fails with "Cannot allocate memory"); use `rssLimitMb` there.
   */
  memLimitMb?: number;
  /** Resident-memory watchdog: the whole process group is killed when its summed RSS exceeds this. 0 = off. */
  rssLimitMb?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Keep at most this many bytes of stdout/stderr (tail) for error messages / parsing. */
  maxCapture?: number;
  /** Command prefix (e.g. ["unshare", "-rn"]) placed before the program. */
  wrapper?: string[];
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Every live child we started, so cancel/shutdown/tests can find and kill them. */
const live = new Set<ChildProcess>();
export const liveChildren = (): ReadonlySet<ChildProcess> => live;

let prlimitPath: string | null = null;
export function setPrlimit(p: string | null): void {
  prlimitPath = p;
}

const PAGE = 4096;

/** Summed resident set size (bytes) of every process in a process group, read from /proc (Linux). */
export function groupRssBytes(pgid: number): number {
  let total = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.charCodeAt(0) < 48 || e.charCodeAt(0) > 57) continue;
    try {
      const stat = fs.readFileSync(`/proc/${e}/stat`, "latin1");
      // pid (comm) state ppid pgrp ... — comm may contain spaces/parens, so split after the last ")".
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(rest[2]) !== pgid) continue;
      const statm = fs.readFileSync(`/proc/${e}/statm`, "latin1").split(" ");
      total += Number(statm[1] ?? 0) * PAGE;
    } catch {
      /* process vanished */
    }
  }
  return total;
}

/** Kill the child's whole process group (children are spawned detached = their own group). */
export function killTree(child: ChildProcess, sig: NodeJS.Signals = "SIGKILL"): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

export function killAllChildren(): void {
  for (const c of live) killTree(c);
}

const appendCapped = (buf: string, add: string, cap: number) => {
  const s = buf + add;
  return s.length > cap ? s.slice(s.length - cap) : s;
};

/**
 * Run a program with an argument array (never a shell). Resolves with exit info for any exit code;
 * rejects only on spawn failure, abort (AbortError) or timeout (TimeoutError).
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new AbortError());
    let file = cmd;
    let argv = args;
    const prefix: string[] = [];
    if (opts.memLimitMb && opts.memLimitMb > 0 && prlimitPath) {
      prefix.push(prlimitPath, `--as=${Math.round(opts.memLimitMb * 1024 * 1024)}`, "--");
    }
    if (opts.wrapper?.length) prefix.push(...opts.wrapper);
    if (prefix.length) {
      file = prefix[0]!;
      argv = [...prefix.slice(1), cmd, ...args];
    }
    const cap = opts.maxCapture ?? 64 * 1024;
    let child: ChildProcess;
    try {
      child = spawn(file, argv, {
        cwd: opts.cwd,
        env: opts.env ?? safeEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // own process group → killTree reaches grandchildren (soffice.bin, gs helpers)
        windowsHide: true,
      });
    } catch (e) {
      return reject(e);
    }
    live.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let failure: Error | null = null;

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      stdout = appendCapped(stdout, d, cap);
      opts.onStdout?.(d);
    });
    child.stderr!.on("data", (d: string) => {
      stderr = appendCapped(stderr, d, cap);
      opts.onStderr?.(d);
    });

    const onAbort = () => {
      failure ??= new AbortError();
      killTree(child);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            failure ??= new TimeoutError(`Processing exceeded the ${Math.round(opts.timeoutMs! / 1000)} s time limit`);
            killTree(child);
          }, opts.timeoutMs)
        : null;

    const rssTimer =
      opts.rssLimitMb && opts.rssLimitMb > 0 && child.pid !== undefined
        ? setInterval(() => {
            if (groupRssBytes(child.pid!) > opts.rssLimitMb! * 1024 * 1024) {
              failure ??= new MemoryLimitError();
              killTree(child);
            }
          }, 750)
        : null;

    const finish = (err: Error | null, res?: RunResult) => {
      if (settled) return;
      settled = true;
      live.delete(child);
      if (timer) clearTimeout(timer);
      if (rssTimer) clearInterval(rssTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      // Make sure nothing in the group survives (e.g. soffice.bin after oosplash exits).
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* group gone */
        }
      }
      if (err) reject(err);
      else resolve(res!);
    };
    child.on("error", (e) => finish(e));
    child.on("close", (code, signal) => {
      if (failure) return finish(failure);
      finish(null, { code, signal, stdout, stderr });
    });
  });
}

/** Minimal environment for children: no secrets (AWS keys etc.) leak into encoders. */
export function safeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "SYSTEMROOT"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.LANG ??= "C.UTF-8";
  return { ...env, ...extra };
}
