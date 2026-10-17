export function formatSize(bytes: number | undefined | null): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(ms: number | undefined | null): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "—";
  const sec = ms / 1000;
  if (sec < 1) return `${Math.round(ms)} ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${Math.round(sec % 60)}s`;
}

export function formatTimer(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Percentage saved (positive = smaller). */
export function savingsPercent(before: number, after: number): number {
  if (!before) return 0;
  return ((before - after) / before) * 100;
}

export function extOf(name: string): string {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? m[1]!.toLowerCase() : "";
}
