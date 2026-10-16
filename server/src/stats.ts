import fs from "node:fs";
import path from "node:path";

/** Aggregate counters only — no file names, no per-user data. */
export class Stats {
  totalJobs = 0;
  totalSavedBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "stats.json");
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Stats>;
      if (Number.isFinite(j.totalJobs)) this.totalJobs = Number(j.totalJobs);
      if (Number.isFinite(j.totalSavedBytes)) this.totalSavedBytes = Number(j.totalSavedBytes);
    } catch {
      /* first run */
    }
  }

  record(toolId: string, inBytes: number, outBytes: number): void {
    this.totalJobs++;
    if (/compress/.test(toolId) && outBytes < inBytes) this.totalSavedBytes += inBytes - outBytes;
    this.timer ??= setTimeout(() => this.flush(), 5000).unref();
  }

  flush(): void {
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ totalJobs: this.totalJobs, totalSavedBytes: this.totalSavedBytes }));
    } catch {
      /* stats are best-effort */
    }
  }

  toJSON() {
    return { totalJobs: this.totalJobs, totalSavedBytes: this.totalSavedBytes };
  }
}
