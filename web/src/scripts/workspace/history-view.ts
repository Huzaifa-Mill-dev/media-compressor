import { clear, h } from "../../lib/dom";
import { formatDuration, formatSize, savingsPercent } from "../../lib/format";
import { clearHistory, loadHistory, type HistoryEntry } from "../../lib/history";

/** Renders the per-device history table. Everything is inserted as text nodes. */
export function renderHistory(root: HTMLElement): void {
  const body = root.querySelector<HTMLElement>("#history-body");
  const count = root.querySelector<HTMLElement>("#history-count");
  const clearBtn = root.querySelector<HTMLButtonElement>("#history-clear");
  if (!body) return;
  clear(body);
  const entries = loadHistory();
  if (entries === null) {
    body.appendChild(h("p", { class: "history-empty" }, "History is unavailable because this browser blocks local storage. Everything else works normally."));
    if (count) count.textContent = "unavailable";
    if (clearBtn) clearBtn.disabled = true;
    return;
  }
  if (count) count.textContent = `${entries.length} saved`;
  if (clearBtn) clearBtn.disabled = entries.length === 0;
  if (entries.length === 0) {
    body.appendChild(h("p", { class: "history-empty" }, "Nothing yet. Finished jobs appear here, stored only in this browser."));
    return;
  }
  const rows = entries.map((e) => row(e));
  body.appendChild(
    h(
      "div",
      { class: "history-body" },
      h(
        "table",
        { class: "file-list-table" },
        h(
          "thead",
          null,
          h("tr", null, ...["File", "Tool", "Original", "Result", "Change", "Where", "Time", "Date"].map((t) => h("th", { scope: "col" }, t))),
        ),
        h("tbody", { id: "history-rows" }, ...rows),
      ),
    ),
  );
}

function row(e: HistoryEntry): HTMLElement {
  const change = savingsPercent(e.inputSize, e.outputSize);
  const when = new Date(e.date);
  return h(
    "tr",
    null,
    h("td", null, h("span", { class: "file-name-cell", title: e.name }, e.name)),
    h("td", null, e.toolName),
    h("td", { class: "num" }, formatSize(e.inputSize)),
    h("td", { class: "num" }, formatSize(e.outputSize)),
    h("td", { class: "num" }, `${change >= 0 ? "−" : "+"}${Math.abs(change).toFixed(1)}%`),
    h("td", null, e.runtime === "browser" ? "Device" : "Server"),
    h("td", { class: "num" }, formatDuration(e.durationMs)),
    h("td", { class: "num" }, Number.isNaN(when.getTime()) ? "—" : when.toLocaleString()),
  );
}

export function wireHistoryClear(root: HTMLElement): void {
  root.querySelector<HTMLButtonElement>("#history-clear")?.addEventListener("click", () => {
    clearHistory();
    renderHistory(root);
  });
}
