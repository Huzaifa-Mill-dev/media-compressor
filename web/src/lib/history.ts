/**
 * Per-user, on-device job history (localStorage). Replaces the old shared server-side
 * history, which exposed every user's filenames. Every access is wrapped: storage can be
 * disabled, full, or throw (Safari private mode, blocked cookies, sandboxed frames).
 */
export interface HistoryEntry {
  name: string;
  toolId: string;
  toolName: string;
  inputSize: number;
  outputSize: number;
  outputs: number;
  runtime: "browser" | "server";
  durationMs: number;
  date: string;
}

export const HISTORY_KEY = "mt:history:v1";
export const HISTORY_LIMIT = 50;

function storage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function isEntry(v: unknown): v is HistoryEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.name === "string" &&
    typeof e.toolId === "string" &&
    typeof e.toolName === "string" &&
    typeof e.inputSize === "number" &&
    typeof e.outputSize === "number" &&
    typeof e.date === "string"
  );
}

/** null = storage unavailable. */
export function loadHistory(): HistoryEntry[] | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

export function addHistory(entry: HistoryEntry): boolean {
  const s = storage();
  if (!s) return false;
  try {
    const list = loadHistory() ?? [];
    list.unshift({ ...entry, name: entry.name.slice(0, 260) });
    s.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
    return true;
  } catch {
    return false;
  }
}

export function clearHistory(): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.removeItem(HISTORY_KEY);
    return true;
  } catch {
    return false;
  }
}
