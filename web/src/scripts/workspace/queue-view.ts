import { clear, h, iconOf } from "../../lib/dom";
import { extOf, formatSize } from "../../lib/format";
import { kindOf } from "./media";
import { isActive, type Item, type JobStatus } from "./types";

export interface QueueCallbacks {
  remove(item: Item): void;
  retry(item: Item): void;
  cancel(item: Item): void;
  /** Move by `delta` positions (multiInput lists). */
  move(item: Item, delta: number): void;
  /** Drag reorder: move item at `from` to index `to`. */
  moveTo(from: number, to: number): void;
}

const LABELS: Record<JobStatus | "ready", string> = {
  ready: "Ready",
  pending: "Ready",
  queued: "Queued",
  processing: "Processing",
  done: "Done",
  error: "Failed",
  cancelled: "Cancelled",
};

export function statusOf(item: Item): JobStatus | "ready" {
  return item.job ? item.job.status : "ready";
}

function itemUrl(item: Item): string {
  item.url ??= URL.createObjectURL(item.file);
  return item.url;
}

export class QueueView {
  private rows = new Map<number, HTMLTableRowElement>();
  private focusKey: string | null = null;
  private items: Item[] = [];

  constructor(
    private readonly tbody: HTMLElement,
    private readonly cb: QueueCallbacks,
    private readonly multi: boolean,
  ) {}

  /** Remember which control to focus after the next render (keeps keyboard users in place). */
  focusAfterRender(item: Item, action: string): void {
    this.focusKey = `${item.id}:${action}`;
  }

  render(items: Item[]): void {
    this.items = items;
    clear(this.tbody);
    this.rows.clear();
    items.forEach((item, index) => {
      const tr = this.buildRow(item, index);
      this.rows.set(item.id, tr);
      this.tbody.appendChild(tr);
    });
    if (this.focusKey) {
      const target = this.tbody.querySelector<HTMLElement>(`[data-focus-key="${this.focusKey}"]:not(:disabled)`);
      (target ?? this.tbody.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
      this.focusKey = null;
    }
  }

  /** Update only the status/actions cells of one row (called on every progress tick). */
  update(item: Item): void {
    const tr = this.rows.get(item.id);
    if (!tr) return;
    const status = statusOf(item);
    const statusCell = tr.querySelector<HTMLElement>("[data-cell=status]");
    if (!statusCell) return;
    if (tr.dataset.status !== status) {
      // Structural change (e.g. processing → done): rebuild this row's cells.
      const index = this.items.indexOf(item);
      const fresh = this.buildRow(item, index);
      tr.replaceWith(fresh);
      this.rows.set(item.id, fresh);
      return;
    }
    if (status === "processing" || status === "queued") this.fillStatus(statusCell, item);
  }

  private fillStatus(cell: HTMLElement, item: Item): void {
    clear(cell);
    const status = statusOf(item);
    const job = item.job;
    const badge = h("span", { class: `status-badge ${status === "ready" ? "" : status}`.trim() }, LABELS[status]);
    cell.appendChild(badge);
    if (job && isActive(job.status)) {
      const pct = Math.max(0, Math.min(100, Math.round(job.percent)));
      const fill = h("span");
      fill.style.width = `${pct}%`; // CSSOM, not a style attribute (CSP-safe)
      cell.appendChild(
        h(
          "div",
          { class: "mini-progress", role: "progressbar", "aria-label": `Progress for ${item.file.name}`, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct },
          fill,
        ),
      );
      const note = job.message || (job.status === "queued" ? "Waiting for a free worker" : "");
      if (note) cell.appendChild(h("div", { class: "queue-summary" }, `${pct}% · ${note}`));
    }
    if (job && (job.status === "error" || job.status === "cancelled") && job.error) {
      cell.appendChild(h("p", { class: "status-error-text" }, job.error));
    }
  }

  private buildRow(item: Item, index: number): HTMLTableRowElement {
    const status = statusOf(item);
    const job = item.job;
    const locked = !!job && (isActive(job.status) || job.status === "done");
    const kind = kindOf(item.file.name, item.file.type);
    const ext = extOf(item.file.name) || "file";

    const thumb = h("div", { class: "table-thumb" });
    if (kind === "image") {
      const img = h("img", { src: itemUrl(item), alt: "", loading: "lazy", decoding: "async" });
      img.addEventListener("error", () => {
        img.remove();
        thumb.textContent = ext.slice(0, 4);
      });
      thumb.appendChild(img);
    } else {
      thumb.textContent = ext.slice(0, 4);
    }

    const tr = h("tr", { "data-id": item.id, "data-status": status });
    if (this.multi) {
      const handle = h(
        "span",
        { class: "drag-handle", "aria-hidden": "true", title: "Drag to reorder" },
        iconOf("grip", 16),
      );
      tr.appendChild(h("td", { class: "col-order" }, h("span", { class: "file-cell" }, handle, h("span", { class: "order-num" }, `${index + 1}`))));
      if (!locked) this.wireDrag(tr, index);
    }
    tr.appendChild(
      h(
        "td",
        null,
        h("div", { class: "file-cell" }, thumb, h("div", { class: "file-name-cell", title: item.file.name, "data-role": "name" }, item.file.name)),
      ),
    );
    tr.appendChild(h("td", { class: "col-type" }, ext.toUpperCase()));
    tr.appendChild(h("td", { class: "num" }, formatSize(item.file.size)));
    const statusCell = h("td", { "data-cell": "status" });
    this.fillStatus(statusCell, item);
    tr.appendChild(statusCell);

    const actions = h("td", { class: "actions" });
    const name = item.file.name;
    const btn = (action: string, label: string, icon: Parameters<typeof iconOf>[0], extra = "", disabled = false) => {
      const b = h(
        "button",
        { type: "button", class: `btn-icon ${extra}`.trim(), "aria-label": `${label} ${name}`, title: label, "data-action": action, "data-focus-key": `${item.id}:${action}`, disabled },
        iconOf(icon, 14),
      );
      return b;
    };
    if (this.multi && !locked) {
      const up = btn("up", "Move up", "up", "neutral", index === 0);
      const down = btn("down", "Move down", "down", "neutral", index === this.items.length - 1);
      up.addEventListener("click", () => this.cb.move(item, -1));
      down.addEventListener("click", () => this.cb.move(item, 1));
      actions.append(up, down);
    }
    if (job && isActive(job.status)) {
      const c = btn("cancel", "Cancel", "x");
      c.addEventListener("click", () => this.cb.cancel(item));
      actions.appendChild(c);
    } else {
      if (job && (job.status === "error" || job.status === "cancelled")) {
        const r = btn("retry", "Retry", "retry", "retry");
        r.addEventListener("click", () => this.cb.retry(item));
        actions.appendChild(r);
      }
      const rm = btn("remove", "Remove", "x");
      rm.addEventListener("click", () => this.cb.remove(item));
      actions.appendChild(rm);
    }
    tr.appendChild(actions);
    return tr;
  }

  private wireDrag(tr: HTMLTableRowElement, index: number): void {
    tr.draggable = true;
    tr.addEventListener("dragstart", (e) => {
      tr.classList.add("dragging");
      e.dataTransfer?.setData("application/x-mt-row", String(index));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    tr.addEventListener("dragend", () => {
      tr.classList.remove("dragging");
      this.tbody.querySelectorAll(".drag-target").forEach((el) => el.classList.remove("drag-target"));
    });
    tr.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("application/x-mt-row")) return;
      e.preventDefault();
      tr.classList.add("drag-target");
    });
    tr.addEventListener("dragleave", () => tr.classList.remove("drag-target"));
    tr.addEventListener("drop", (e) => {
      const raw = e.dataTransfer?.getData("application/x-mt-row");
      tr.classList.remove("drag-target");
      if (raw === undefined || raw === "") return;
      e.preventDefault();
      e.stopPropagation();
      const from = Number(raw);
      if (Number.isInteger(from) && from !== index) this.cb.moveTo(from, index);
    });
  }
}
