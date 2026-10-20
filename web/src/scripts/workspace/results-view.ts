import type { JobOutput, ToolDefinition } from "../../../../engine/src/types.ts";
import { h, iconOf, clear } from "../../lib/dom";
import { extOf, formatDuration, formatSize, savingsPercent } from "../../lib/format";
import { kindOf, syncPair, togglePair } from "./media";
import type { Job } from "./types";

export interface ResultCallbacks {
  openCompare(title: string, origUrl: string, compUrl: string, dims: string): void;
  zipJob(job: Job): void;
}

function itemUrl(job: Job): string {
  const item = job.items[0]!;
  item.url ??= URL.createObjectURL(item.file);
  return item.url;
}

export function displayName(job: Job): string {
  const first = job.items[0]?.file.name ?? "file";
  return job.items.length > 1 ? `${first} + ${job.items.length - 1} more` : first;
}

export function totalOutputSize(outputs: JobOutput[]): number {
  return outputs.reduce((s, o) => s + o.size, 0);
}

function runtimeBadge(runtime: "browser" | "server"): HTMLElement {
  return runtime === "browser"
    ? h("span", { class: "badge runtime-browser", title: "Processed locally; the file never left your device" }, iconOf("device", 13), "On your device")
    : h("span", { class: "badge runtime-server", title: "Uploaded over HTTPS, processed, then deleted" }, iconOf("server", 13), "On our server");
}

export function downloadLink(out: JobOutput, url: string, small = true): HTMLAnchorElement {
  return h(
    "a",
    { class: small ? "btn-download small" : "btn-download", href: url, download: out.filename, "aria-label": `Download ${out.filename}` },
    iconOf("download", 14),
    "Download",
  );
}

export function buildResultCard(job: Job, tool: ToolDefinition, cb: ResultCallbacks): HTMLElement {
  const result = job.result!;
  const outputs = result.outputs;
  const primary = outputs[0]!;
  const urls = job.outputUrls;
  const outSize = totalOutputSize(outputs);
  const saved = savingsPercent(result.inputSize, outSize);
  const isCompress = tool.id.endsWith("compress");
  const grew = outSize > result.inputSize;

  const badges = h("div", { class: "badges" }, runtimeBadge(result.runtime));
  badges.appendChild(h("span", { class: "badge", title: "Processing time" }, iconOf("clock", 13), formatDuration(result.durationMs)));
  const q = result.meta?.qualityScore;
  if (typeof q === "number" && Number.isFinite(q)) {
    badges.appendChild(h("span", { class: "badge quality", title: "SSIM-derived similarity to the original" }, iconOf("check", 13), `Quality ${q.toFixed(1)} / 100`));
  }
  if (outputs.length === 1) badges.appendChild(downloadLink(primary, urls[0]!));
  else
    badges.appendChild(
      (() => {
        const b = h("button", { type: "button", class: "btn-download small" }, iconOf("download", 14), `Download ${outputs.length} files (ZIP)`);
        b.addEventListener("click", () => cb.zipJob(job));
        return b;
      })(),
    );

  const header = h(
    "div",
    { class: "result-header" },
    h("div", { class: "result-filename", title: `${displayName(job)} → ${primary.filename}` }, `${displayName(job)} → ${primary.filename}`),
    badges,
  );

  const statsClass = grew ? (isCompress ? "stat-card growth" : "stat-card") : "stat-card savings";
  const pct = `${grew ? "+" : "−"}${Math.abs(saved).toFixed(1)}%`;
  const stats = h(
    "div",
    { class: "stats-row" },
    h("div", { class: "stat-card" }, h("p", { class: "stat-label" }, "Original"), h("p", { class: "stat-value", "data-role": "in-size" }, formatSize(result.inputSize))),
    h("div", { class: "stat-card stat-arrow" }, iconOf("arrow", 24)),
    h("div", { class: "stat-card" }, h("p", { class: "stat-label" }, outputs.length > 1 ? `Result (${outputs.length} files)` : "Result"), h("p", { class: "stat-value", "data-role": "out-size" }, formatSize(outSize))),
    h("div", { class: statsClass }, h("p", { class: "stat-label" }, grew ? "Larger by" : "Saved"), h("p", { class: "stat-value", "data-role": "savings" }, pct)),
  );

  const card = h("article", { class: "result-item", "data-job-id": job.id, "aria-label": `Result for ${displayName(job)}` }, header, stats);

  if (grew && isCompress) {
    card.appendChild(
      h(
        "p",
        { class: "notice warn", role: "note" },
        "This file was already well optimised, so the result is larger. Keep the original, or try a lower quality setting.",
      ),
    );
  }

  const preview = buildPreview(job, cb);
  if (preview) card.appendChild(preview);

  if (outputs.length > 1) {
    const list = h("ul", { class: "outputs-list", "aria-label": "Output files" });
    outputs.forEach((o, i) => {
      list.appendChild(
        h("li", null, h("span", { class: "name", title: o.filename }, o.filename), h("span", { class: "size" }, formatSize(o.size)), downloadLink(o, urls[i]!)),
      );
    });
    card.appendChild(list);
  }

  card.appendChild(buildDetails(job));
  return card;
}

function dims(w: unknown, hgt: unknown): string | null {
  return typeof w === "number" && typeof hgt === "number" ? `${w} × ${hgt}` : null;
}

function buildPreview(job: Job, cb: ResultCallbacks): HTMLElement | null {
  const result = job.result!;
  if (result.outputs.length !== 1) return null;
  const out = result.outputs[0]!;
  const urls = job.outputUrls;
  const outKind = kindOf(out.filename, out.mime);
  if (outKind === "other") return null;
  const inItem = job.items[0]!;
  const sameKind = job.items.length === 1 && kindOf(inItem.file.name, inItem.file.type) === outKind;
  const meta = result.meta ?? {};

  const make = (url: string): HTMLElement => {
    if (outKind === "image") return h("img", { src: url, alt: "" });
    if (outKind === "video") return h("video", { src: url, controls: true, playsinline: true, preload: "metadata" });
    return h("audio", { src: url, controls: true, preload: "metadata" });
  };
  const box = (label: string, cls: string, size: number, el: HTMLElement, extra?: string | null) =>
    h(
      "div",
      { class: "side-player-card" },
      h("div", { class: "side-player-header" }, h("span", { class: cls }, label), h("span", null, [formatSize(size), extra].filter(Boolean).join(" · "))),
      h("div", { class: `side-player-body${outKind === "audio" ? " audio-box" : ""}` }, el),
    );

  const outBox = box(sameKind ? "Compressed" : "Result", "label-comp", out.size, make(urls[0]!), dims(meta.outputWidth, meta.outputHeight));
  const wrap = h("div", { class: "side-by-side-preview", "data-role": "preview" });
  if (!sameKind) {
    wrap.style.gridTemplateColumns = "1fr";
    wrap.appendChild(outBox);
    return wrap;
  }
  const origEl = make(itemUrl(job));
  if (origEl instanceof HTMLMediaElement) origEl.muted = outKind === "video";
  wrap.append(box("Original", "label-orig", inItem.file.size, origEl, dims(meta.width, meta.height)), outBox);

  if (outKind !== "video") return wrap;

  const o = origEl as HTMLVideoElement;
  const c = outBox.querySelector("video") as HTMLVideoElement;
  syncPair(o, c);
  const playBtn = h("button", { type: "button", class: "btn-secondary" }, iconOf("play", 14, true), "Play both in sync");
  playBtn.addEventListener("click", () => togglePair(o, c));
  const fs = h("button", { type: "button", class: "btn-secondary" }, iconOf("expand", 14), "Fullscreen comparison");
  fs.addEventListener("click", () => cb.openCompare(`${displayName(job)} → ${out.filename}`, itemUrl(job), urls[0]!, dims(meta.outputWidth, meta.outputHeight) ?? ""));
  const frag = h("div", null, wrap, h("div", { class: "preview-actions-bar" }, playBtn, fs));
  return frag;
}

function buildDetails(job: Job): HTMLElement {
  const result = job.result!;
  const meta = result.meta ?? {};
  const rows: [string, string][] = [];
  rows.push(["Runs", result.runtime === "browser" ? "On your device" : "On our server"]);
  rows.push(["Time taken", formatDuration(result.durationMs)]);
  const d1 = dims(meta.width, meta.height);
  const d2 = dims(meta.outputWidth, meta.outputHeight);
  if (d1) rows.push(["Dimensions", d2 && d2 !== d1 ? `${d1} → ${d2}` : d1]);
  if (typeof meta.durationSec === "number") rows.push(["Duration", formatDuration(meta.durationSec * 1000)]);
  if (typeof meta.pages === "number") rows.push(["Pages", String(meta.pages)]);
  if (typeof meta.codec === "string") rows.push(["Codec", meta.codec]);
  if (typeof meta.qualityScore === "number") rows.push(["Quality score", `${meta.qualityScore.toFixed(1)} / 100`]);
  if (meta.scanned === true) rows.push(["Text", "Looks scanned: pages are kept as images, so the text isn't editable"]);
  rows.push(["Output format", (extOf(result.outputs[0]!.filename) || result.outputs[0]!.mime).toUpperCase()]);
  const known = new Set(["width", "height", "outputWidth", "outputHeight", "durationSec", "pages", "qualityScore", "codec", "scanned"]);
  for (const [k, v] of Object.entries(meta)) {
    if (known.has(k) || (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")) continue;
    rows.push([k.replace(/([A-Z])/g, " $1").replace(/^./, (m) => m.toUpperCase()), String(v)]);
  }
  const body = h("tbody");
  for (const [k, v] of rows) body.appendChild(h("tr", null, h("th", { scope: "row" }, k), h("td", null, v)));
  return h("details", { class: "details-panel" }, h("summary", null, "Technical details"), h("table", { class: "details-table" }, body));
}

export class ResultsView {
  private cards = new Map<number, HTMLElement>();
  constructor(
    private readonly container: HTMLElement,
    private readonly tool: ToolDefinition,
    private readonly cb: ResultCallbacks,
  ) {}

  add(job: Job): void {
    this.remove(job);
    const card = buildResultCard(job, this.tool, this.cb);
    this.cards.set(job.id, card);
    this.container.appendChild(card);
  }

  remove(job: Job): void {
    this.cards.get(job.id)?.remove();
    this.cards.delete(job.id);
  }

  clear(): void {
    this.cards.clear();
    clear(this.container);
  }

  get size(): number {
    return this.cards.size;
  }
}
