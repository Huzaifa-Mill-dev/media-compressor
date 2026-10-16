import { formatSize } from "../lib/format";

async function loadStats(): Promise<void> {
  const badge = document.getElementById("stats-badge");
  const text = document.getElementById("stats-text");
  if (!badge || !text) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch("/api/stats", { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { totalJobs?: unknown; totalSavedBytes?: unknown };
    const jobs = Number(data.totalJobs);
    const saved = Number(data.totalSavedBytes);
    if (!Number.isFinite(jobs) || !Number.isFinite(saved) || jobs < 0 || saved < 0) throw new Error("bad stats");
    text.textContent = `${formatSize(saved)} saved across ${jobs.toLocaleString("en-US")} jobs`;
    badge.dataset.state = "online";
  } catch {
    text.textContent = "Private by design";
    badge.dataset.state = "offline";
    badge.title = "Live stats are unavailable right now. On-device tools keep working.";
  } finally {
    clearTimeout(timer);
  }
}

void loadStats();
