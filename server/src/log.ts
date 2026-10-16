export type LogLevel = "silent" | "error" | "info";

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

/**
 * Minimal structured logger. Never log user-supplied file names verbatim (they may contain control
 * characters / terminal escapes); callers pass job ids and sizes instead.
 */
export function createLogger(level: LogLevel): Logger {
  const out = (lvl: string, msg: string, extra?: Record<string, unknown>) => {
    const line = JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...extra });
    if (lvl === "info") console.log(line);
    else console.error(line);
  };
  return {
    info: (m, e) => level === "info" && out("info", m, e),
    warn: (m, e) => level !== "silent" && out("warn", m, e),
    error: (m, e) => level !== "silent" && out("error", m, e),
  };
}
