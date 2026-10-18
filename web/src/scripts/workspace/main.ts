/**
 * Workspace controller: queue, option form, job orchestration, results, history.
 * Zero-framework TypeScript — the page is mostly static SEO content, so the JS budget
 * goes to the engine, not to a UI runtime. All user-controlled strings reach the DOM
 * through textContent / attributes only (see lib/dom.ts).
 */
import type { JobProgress, JobResult, Options, ToolDefinition } from "../../../../engine/src/types.ts";
import { actionLabel, minFiles } from "../../lib/content";
import { clear, h } from "../../lib/dom";
import { getEngine } from "../../lib/engine";
import { formatTimer } from "../../lib/format";
import { renderOptionsForm, type OptionsForm } from "../../lib/form";
import { addHistory } from "../../lib/history";
import { buildZip } from "../../lib/zip";
import { normaliseName, screenFiles, type Rejection } from "./files";
import { renderHistory, wireHistoryClear } from "./history-view";
import { togglePair, syncPair } from "./media";
import { confirmInterrupt, liveAnnounce, notice, wireBackdropClose } from "./modals";
import { QueueView } from "./queue-view";
import { displayName, ResultsView, totalOutputSize } from "./results-view";
import { isActive, type Item, type Job } from "./types";

const $ = <T extends HTMLElement>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`workspace: missing ${sel}`);
  return el;
};

const STAGE_TEXT: Record<string, string> = {
  queued: "Waiting for a free worker",
  "loading-engine": "Loading the converter (first use only)",
  uploading: "Uploading to our server",
  processing: "Processing",
  finalizing: "Finalising",
};

function startWorkspace(root: HTMLElement): void {
  const tool = JSON.parse($(root, "#tool-data").textContent ?? "null") as ToolDefinition;
  const multi = tool.multiInput;
  const verb = actionLabel(tool);
  const needed = minFiles(tool);

  // ── elements ──
  const dropZone = $<HTMLButtonElement>(root, "#drop-zone");
  const fileInput = $<HTMLInputElement>(root, "#file-input");
  const notices = $(root, "#notices");
  const queueBox = $(root, "#queue");
  const queueBody = $(root, "#queue-body");
  const queueSummary = $(root, "#queue-summary");
  const clearBtn = $<HTMLButtonElement>(root, "#clear-btn");
  const optionsMount = $(root, "#options-mount");
  const serverNotice = $(root, "#server-notice");
  const runBtn = $<HTMLButtonElement>(root, "#run-btn");
  const runText = $(root, "#run-btn .btn-text");
  const runLoader = $(root, "#run-btn .btn-loader");
  const progressCard = $(root, "#progress-card");
  const progressFill = $(root, "#progress-fill");
  const progressBar = $(root, "#progress-bar");
  const progressTimer = $(root, "#progress-timer");
  const progressPercent = $(root, "#progress-percent");
  const progressTitle = $(root, "#progress-title");
  const progressText = $(root, "#progress-text");
  const progressSub = $(root, "#progress-sub");
  const cancelAllBtn = $<HTMLButtonElement>(root, "#cancel-all-btn");
  const resultsCard = $(root, "#results-card");
  const resultsEl = $(root, "#results");
  const zipAllBtn = $<HTMLButtonElement>(root, "#zip-all-btn");
  const historyRoot = $(document.body, "#history");

  // ── state ──
  const items: Item[] = [];
  const jobs = new Set<Job>();
  let nextId = 1;
  let nextJobId = 1;
  let batch: { start: number; jobs: Set<Job> } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let raf = 0;
  let serverUp: boolean | null = null; // null = unknown
  let lastLive = "";

  const form: OptionsForm = renderOptionsForm(tool, "opt");
  if (tool.options.length > 0) optionsMount.appendChild(form.root);
  else $(root, "#options-title").hidden = true;

  const queue = new QueueView(
    queueBody,
    {
      remove: (item) => removeItem(item),
      retry: (item) => retryItem(item),
      cancel: (item) => item.job?.ctrl?.abort(),
      move: (item, delta) => {
        const i = items.indexOf(item);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= items.length) return;
        items.splice(j, 0, items.splice(i, 1)[0]!);
        queue.focusAfterRender(item, delta < 0 ? "up" : "down");
        refreshAll();
        liveAnnounce(`${item.file.name} moved to position ${j + 1} of ${items.length}`);
      },
      moveTo: (from, to) => {
        if (from < 0 || from >= items.length || to < 0 || to >= items.length) return;
        items.splice(to, 0, items.splice(from, 1)[0]!);
        refreshAll();
      },
    },
    multi,
  );

  const results = new ResultsView(resultsEl, tool, {
    openCompare: openCompareDialog,
    zipJob: (job) => void zipJobs([job], `${tool.slug}-${job.id}.zip`, null),
  });

  // ── helpers ──
  const running = () => [...jobs].some((j) => isActive(j.status));
  const autoStart = !multi && tool.options.length > 0 && tool.options.every((o) => o.advanced) && tool.runtimes.includes("browser");
  const readyCount = () => (multi ? items.filter((i) => !i.job).length : items.filter((i) => i.job?.status === "pending").length);

  function showNotice(node: HTMLElement): void {
    notices.appendChild(node);
  }
  function clearNotices(): void {
    clear(notices);
  }

  function discardJob(job: Job): void {
    job.ctrl?.abort();
    results.remove(job);
    for (const u of job.outputUrls) URL.revokeObjectURL(u);
    job.outputUrls = [];
    jobs.delete(job);
    batch?.jobs.delete(job);
    for (const it of job.items) if (it.job === job) it.job = null;
  }

  function dropItem(item: Item): void {
    const idx = items.indexOf(item);
    if (idx >= 0) items.splice(idx, 1);
    if (item.url) URL.revokeObjectURL(item.url);
    item.url = undefined;
  }

  function removeItem(item: Item): void {
    const job = item.job;
    if (job) {
      if (isActive(job.status)) job.ctrl?.abort();
      discardJob(job);
    }
    dropItem(item);
    refreshAll();
    afterStructureChange();
  }

  function retryItem(item: Item): void {
    const job = item.job;
    if (!job) return;
    if (multi) {
      discardJob(job);
    } else {
      job.status = "pending";
      job.error = undefined;
      job.percent = 0;
      job.message = "";
    }
    refreshAll();
    startRun();
  }

  function afterStructureChange(): void {
    if (items.length === 0) {
      queueBox.hidden = true;
    }
    updateResultsCard();
    updateControls();
  }

  function updateResultsCard(): void {
    const any = results.size > 0;
    resultsCard.hidden = !any;
    const outputs = [...jobs].reduce((n, j) => n + (j.status === "done" ? (j.result?.outputs.length ?? 0) : 0), 0);
    zipAllBtn.hidden = outputs < 2;
  }

  function updateControls(): void {
    const isRunning = running();
    const ready = readyCount();
    const enoughFiles = !multi || ready >= needed;
    const toolUnavailable = tool.runtimes.length === 1 && tool.runtimes[0] === "server" && serverUp === false;
    runBtn.disabled = ready === 0 || !enoughFiles || toolUnavailable;
    runLoader.hidden = !(isRunning && ready === 0);
    runText.hidden = isRunning && ready === 0;
    runText.textContent =
      ready === 0
        ? verb
        : multi
          ? `${verb} ${ready} file${ready === 1 ? "" : "s"}`
          : `${verb} ${ready} file${ready === 1 ? "" : "s"}`;
    if (multi && ready > 0 && ready < needed) runBtn.title = `Add at least ${needed} files`;
    else runBtn.removeAttribute("title");
    clearBtn.disabled = items.length === 0;
    dropZone.removeAttribute("aria-disabled");
    const done = items.filter((i) => i.job?.status === "done").length;
    const failed = items.filter((i) => i.job && (i.job.status === "error" || i.job.status === "cancelled")).length;
    const bits = [`${items.length} file${items.length === 1 ? "" : "s"}`];
    if (done) bits.push(`${done} done`);
    if (failed) bits.push(`${failed} failed or cancelled`);
    if (multi && ready > 0 && ready < needed) bits.push(`add at least ${needed} to ${verb.toLowerCase()}`);
    queueSummary.textContent = bits.join(" · ");
  }

  function refreshAll(): void {
    queueBox.hidden = items.length === 0;
    queue.render(items);
    updateControls();
  }

  // ── adding files ──
  function addFiles(list: File[]): void {
    clearNotices();
    if (list.length === 0) return;
    const named = list.map(normaliseName);
    const { accepted, rejected } = screenFiles(tool, named, items.length);
    for (const file of accepted) {
      const item: Item = { id: nextId++, file, job: null };
      if (!multi) item.job = { id: nextJobId++, items: [item], status: "pending", percent: 0, message: "", outputUrls: [] };
      items.push(item);
      if (item.job) jobs.add(item.job);
    }
    if (rejected.length) showNotice(rejectionNotice(rejected));
    if (accepted.length) {
      refreshAll();
      liveAnnounce(`${accepted.length} file${accepted.length === 1 ? "" : "s"} added`);
      void prefetchEngine();
      // One-click tools (nothing to choose upfront, runs on the device): start right away, like TinyPNG. Opening
      // "Advanced options" means the visitor wants to tweak first, so then we wait for the button.
      if (autoStart && !root.querySelector("details.advanced-options[open]") && !runBtn.disabled) startRun();
    }
  }

  function rejectionNotice(rej: Rejection[]): HTMLElement {
    const shown = rej.slice(0, 8);
    const ul = h("ul", { "data-role": "rejected" });
    for (const r of shown) ul.appendChild(h("li", null, h("strong", null, r.name), ` — ${r.reason}`));
    if (rej.length > shown.length) ul.appendChild(h("li", null, `…and ${rej.length - shown.length} more`));
    return notice("error", h("div", null, `${rej.length} file${rej.length === 1 ? " was" : "s were"} not added:`, ul));
  }

  // Drop zone: click / keyboard (native button) / drag & drop anywhere on the page / paste.
  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    addFiles(Array.from(fileInput.files ?? []));
    fileInput.value = "";
  });
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    dropZone.classList.add("drag-over");
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropZone.classList.remove("drag-over");
  });
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // otherwise the browser would navigate to the dropped file
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove("drag-over");
    addFiles(Array.from(e.dataTransfer?.files ?? []));
  });
  window.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    addFiles(files);
  });

  // ── running jobs ──
  async function prefetchEngine(): Promise<void> {
    try {
      const engine = await getEngine();
      if (serverUp === null) {
        const caps = await engine.capabilities();
        serverUp = caps.serverTools.includes(tool.id);
        showServerNotice();
        updateControls();
      }
    } catch {
      /* surfaced when a job actually runs */
    }
  }

  function showServerNotice(): void {
    clear(serverNotice);
    const serverOnly = tool.runtimes.length === 1 && tool.runtimes[0] === "server";
    if (serverUp === false && serverOnly) {
      serverNotice.appendChild(
        notice("warn", `${tool.title.split(" — ")[0]} needs our server, which is unavailable right now. Please try again in a few minutes.`),
      );
    } else if (serverUp === false && !tool.runtimes.includes("browser")) {
      serverNotice.appendChild(notice("warn", "Our server is unavailable right now."));
    }
  }

  function startRun(): void {
    const problems = form.validate();
    if (problems.length) {
      clearNotices();
      showNotice(notice("error", h("div", null, "Please fix the options first:", h("ul", null, ...problems.map((p) => h("li", null, p))))));
      root.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    const options = form.values();
    const todo: Job[] = [];
    if (multi) {
      const free = items.filter((i) => !i.job);
      if (free.length < needed) return;
      const job: Job = { id: nextJobId++, items: free.slice(), status: "pending", percent: 0, message: "", outputUrls: [] };
      for (const it of free) it.job = job;
      jobs.add(job);
      todo.push(job);
    } else {
      for (const it of items) if (it.job?.status === "pending") todo.push(it.job);
    }
    if (todo.length === 0) return;
    clearNotices();
    if (!batch || !running()) {
      batch = { start: Date.now(), jobs: new Set() };
      beginTimer();
    }
    for (const job of todo) {
      batch.jobs.add(job);
      void runJob(job, options);
    }
    progressCard.hidden = false;
    refreshAll();
    scheduleUi();
  }

  async function runJob(job: Job, options: Options): Promise<void> {
    job.status = "queued";
    job.percent = 0;
    job.message = STAGE_TEXT.queued ?? "";
    job.error = undefined;
    const ctrl = new AbortController();
    job.ctrl = ctrl;
    const onProgress = (p: JobProgress) => {
      if (job.status === "done" || job.status === "error" || job.status === "cancelled") return;
      job.status = p.stage === "queued" ? "queued" : "processing";
      job.percent = p.percent;
      job.runtime = p.runtime;
      job.message = p.message ?? STAGE_TEXT[p.stage] ?? "";
      scheduleUi();
    };
    try {
      const engine = await getEngine();
      if (ctrl.signal.aborted) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
      const result = await engine.run({ toolId: tool.id, files: job.items.map((i) => i.file), options }, { onProgress, signal: ctrl.signal });
      finishOk(job, result);
    } catch (err) {
      const aborted = ctrl.signal.aborted || (err instanceof Error && err.name === "AbortError");
      job.status = aborted ? "cancelled" : "error";
      job.error = aborted ? "Cancelled" : friendlyError(err);
      job.percent = 0;
    } finally {
      job.ctrl = undefined;
      afterJobSettled(job);
    }
  }

  function friendlyError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return (msg || "Something went wrong.").slice(0, 400);
  }

  function finishOk(job: Job, result: JobResult): void {
    if (!result.outputs || result.outputs.length === 0) throw new Error("The tool finished without producing a file.");
    job.result = result;
    job.runtime = result.runtime;
    job.percent = 100;
    job.status = "done";
    job.outputUrls = result.outputs.map((o) => URL.createObjectURL(o.blob));
    const first = job.items[0];
    if (first && jobs.has(job)) {
      results.add(job);
      addHistory({
        name: displayName(job),
        toolId: tool.id,
        toolName: tool.title.split(" — ")[0] ?? tool.title,
        inputSize: result.inputSize,
        outputSize: totalOutputSize(result.outputs),
        outputs: result.outputs.length,
        runtime: result.runtime,
        durationMs: result.durationMs,
        date: new Date().toISOString(),
      });
      renderHistory(historyRoot);
    } else {
      // The item was removed while the job was finishing — drop the output.
      for (const u of job.outputUrls) URL.revokeObjectURL(u);
      job.outputUrls = [];
    }
  }

  function afterJobSettled(job: Job): void {
    if (jobs.has(job)) {
      refreshQueueRows(job);
      updateResultsCard();
    }
    scheduleUi();
    if (!running() && batch) endBatch();
  }

  function refreshQueueRows(job: Job): void {
    for (const it of job.items) queue.update(it);
  }

  function endBatch(): void {
    if (timer) clearInterval(timer);
    timer = null;
    const b = batch;
    batch = null;
    progressCard.hidden = true;
    if (!b) return;
    const all = [...b.jobs].filter((j) => jobs.has(j));
    const ok = all.filter((j) => j.status === "done").length;
    const bad = all.filter((j) => j.status === "error").length;
    const cancelled = all.filter((j) => j.status === "cancelled").length;
    liveAnnounce(`Finished: ${ok} done${bad ? `, ${bad} failed` : ""}${cancelled ? `, ${cancelled} cancelled` : ""}.`);
    if (ok > 0) resultsCard.scrollIntoView({ block: "nearest" });
    refreshAll();
  }

  // ── progress UI ──
  function beginTimer(): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (batch) progressTimer.textContent = formatTimer(Date.now() - batch.start);
    }, 250);
    progressTimer.textContent = "00:00";
  }

  function scheduleUi(): void {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paintProgress();
    });
  }

  function paintProgress(): void {
    for (const it of items) if (it.job && isActive(it.job.status)) queue.update(it);
    updateControls();
    if (!batch) return;
    const list = [...batch.jobs].filter((j) => jobs.has(j));
    if (list.length === 0) return;
    const total = list.reduce((s, j) => s + (isActive(j.status) || j.status === "pending" ? j.percent : 100), 0) / list.length;
    const pct = Math.round(Math.max(0, Math.min(100, total)));
    progressFill.style.width = `${pct}%`;
    progressBar.setAttribute("aria-valuenow", String(pct));
    progressPercent.textContent = `${pct}%`;
    const active = list.filter((j) => isActive(j.status));
    const finished = list.length - active.length;
    progressTitle.textContent = `${verb}… ${finished} of ${list.length} finished`;
    const lead = active.find((j) => j.status === "processing") ?? active[0];
    const text = lead?.message || "Working…";
    progressText.textContent = text;
    const rts = new Set(list.map((j) => j.runtime).filter(Boolean));
    progressSub.textContent =
      rts.size === 0 ? "Choosing the fastest place to run…" : [...rts].map((r) => (r === "browser" ? "On your device" : "On our server")).join(" + ");
    const live = `${finished} of ${list.length} finished`;
    if (live !== lastLive) {
      lastLive = live;
      $(root, "#progress-live").textContent = live;
    }
  }

  function cancelAll(): void {
    for (const j of jobs) if (isActive(j.status)) j.ctrl?.abort();
  }

  // ── clear / start over ──
  async function clearAll(): Promise<void> {
    if (running()) {
      const ok = await confirmInterrupt(
        "Files are still being processed. Clearing now cancels the jobs in progress and discards their results.",
        "Cancel jobs and clear",
      );
      if (!ok) return;
    }
    cancelAll();
    for (const j of [...jobs]) discardJob(j);
    for (const it of [...items]) dropItem(it);
    results.clear();
    clearNotices();
    refreshAll();
    afterStructureChange();
    dropZone.focus();
  }

  // ── ZIP ──
  async function zipJobs(list: Job[], name: string, btn: HTMLButtonElement | null): Promise<void> {
    const entries = list.flatMap((j) => (j.result?.outputs ?? []).map((o) => ({ name: o.filename, blob: o.blob })));
    if (entries.length === 0) return;
    const label = btn?.textContent ?? "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Preparing ZIP…";
    }
    try {
      const blob = await buildZip(entries);
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      showNotice(notice("error", `Could not build the ZIP: ${friendlyError(err)}`));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
  }

  // ── compare dialog (video) ──
  const compare = document.getElementById("compare-dialog") as HTMLDialogElement | null;
  let compareReady = false;
  function openCompareDialog(title: string, origUrl: string, compUrl: string, dims: string): void {
    if (!compare) return;
    const a = $<HTMLVideoElement>(compare, "#compare-orig");
    const b = $<HTMLVideoElement>(compare, "#compare-comp");
    const playBtn = $<HTMLButtonElement>(compare, "#compare-play");
    if (!compareReady) {
      compareReady = true;
      wireBackdropClose(compare);
      const label = $(playBtn, "span");
      syncPair(a, b, (playing) => (label.textContent = playing ? "Pause both" : "Play both in sync"));
      playBtn.addEventListener("click", () => togglePair(a, b));
      compare.addEventListener("close", () => {
        for (const v of [a, b]) {
          v.pause();
          v.removeAttribute("src");
          v.load();
        }
      });
    }
    $(compare, "#compare-title").textContent = title;
    $(compare, "#compare-dims").textContent = dims;
    a.src = origUrl;
    b.src = compUrl;
    compare.showModal();
    a.currentTime = 0;
    b.currentTime = 0;
    void a.play().catch(() => {});
    void b.play().catch(() => {});
  }

  // ── wiring ──
  runBtn.addEventListener("click", startRun);
  cancelAllBtn.addEventListener("click", cancelAll);
  clearBtn.addEventListener("click", () => void clearAll());
  zipAllBtn.addEventListener("click", () => void zipJobs([...jobs].filter((j) => j.status === "done"), `${tool.slug}-results.zip`, zipAllBtn));
  $<HTMLButtonElement>(root, "#clear-results-btn").addEventListener("click", () => {
    for (const j of [...jobs]) {
      if (j.status !== "done") continue;
      if (multi) {
        for (const it of j.items) it.job = null;
        discardJob(j);
      } else {
        const it = j.items[0];
        discardJob(j);
        if (it) dropItem(it);
      }
    }
    refreshAll();
    afterStructureChange();
  });
  wireHistoryClear(historyRoot);
  renderHistory(historyRoot);

  window.addEventListener("beforeunload", (e) => {
    if (!running()) return;
    e.preventDefault();
    e.returnValue = "";
  });

  // Same-site navigation while a job runs → in-page warning (beforeunload covers everything else).
  document.addEventListener(
    "click",
    (e) => {
      if (!running() || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download") || a.href.startsWith("blob:")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.hash)) return;
      e.preventDefault();
      void confirmInterrupt("Leaving this page now will cancel the jobs in progress and you will lose their results.", "Leave and cancel").then((ok) => {
        if (!ok) return;
        cancelAll();
        location.assign(a.href);
      });
    },
    true,
  );

  const warn = document.getElementById("warning-dialog") as HTMLDialogElement | null;
  if (warn) wireBackdropClose(warn);

  refreshAll();
  afterStructureChange();

  // Server-only tools: find out right away whether the server is reachable.
  if (tool.runtimes.length === 1 && tool.runtimes[0] === "server") void prefetchEngine();

  // Test hook (only present in PUBLIC_TEST_HOOKS builds).
  if (import.meta.env.PUBLIC_TEST_HOOKS === "1") {
    (window as unknown as { __MT_STATE__?: unknown }).__MT_STATE__ = { items, jobs };
  }
}

const root = document.getElementById("workspace");
if (root) startWorkspace(root);
