/**
 * Header badge. On-device jobs never reach the server, so the server's aggregate alone would read "0 jobs" right after
 * a successful conversion. Show the visitor's own savings (from this browser's history) first, the site-wide
 * aggregate second, and the privacy promise when there is nothing to count yet.
 */
import { formatSize } from "../lib/format";
import { HISTORY_EVENT, loadHistory } from "../lib/history";

const badge = document.getElementById("stats-badge");
const text = document.getElementById("stats-text");
let server: { jobs: number; saved: number } | null = null;

function render(): void {
  if (!badge || !text) return;
  const list = loadHistory() ?? [];
  const saved = list.reduce((a, e) => a + Math.max(0, e.inputSize - e.outputSize), 0);
  if (list.length > 0) {
    text.textContent = saved > 0 ? `You saved ${formatSize(saved)}` : `${list.length} file${list.length === 1 ? "" : "s"} processed`;
    badge.title = `${list.length} recent job${list.length === 1 ? "" : "s"} in this browser`;
    badge.dataset.state = "online";
  } else if (server && server.jobs > 0) {
    text.textContent = `${formatSize(server.saved)} saved for everyone`;
    badge.title = `${server.jobs.toLocaleString("en-US")} files processed on our server`;
    badge.dataset.state = "online";
  } else {
    text.textContent = "Private by design";
    badge.title = "Most files are processed on your device and never uploaded.";
    badge.dataset.state = server ? "online" : "offline";
  }
}

async function loadServer(): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch("/api/stats", { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { totalJobs?: unknown; totalSavedBytes?: unknown };
    const jobs = Number(data.totalJobs);
    const saved = Number(data.totalSavedBytes);
    if (Number.isFinite(jobs) && Number.isFinite(saved) && jobs >= 0 && saved >= 0) server = { jobs, saved };
  } catch {
    server = null;
  } finally {
    clearTimeout(timer);
  }
  render();
}

render();
// The site-wide counter is non-essential: fetch it once the page is idle so it never competes with first paint.
const idle = (fn: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 2000));
if (document.readyState === "complete") idle(() => void loadServer());
else window.addEventListener("load", () => idle(() => void loadServer()), { once: true });
window.addEventListener(HISTORY_EVENT, render);
window.addEventListener("storage", render);
