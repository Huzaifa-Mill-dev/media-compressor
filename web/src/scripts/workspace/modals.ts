/** Native <dialog> helpers (focus trap, Esc, backdrop come for free). */
import { h } from "../../lib/dom";

let pending: Promise<boolean> | null = null;

/** Interrupt warning. Resolves true when the user chooses to abort/continue anyway. */
export function confirmInterrupt(message: string, confirmLabel: string): Promise<boolean> {
  const dlg = document.getElementById("warning-dialog") as HTMLDialogElement | null;
  if (!dlg) return Promise.resolve(true);
  if (pending) return pending;
  const desc = dlg.querySelector<HTMLElement>("#warning-desc");
  const abort = dlg.querySelector<HTMLElement>("#warning-abort");
  if (desc) desc.textContent = message;
  if (abort) abort.textContent = confirmLabel;
  dlg.returnValue = "";
  pending = new Promise<boolean>((resolve) => {
    dlg.addEventListener(
      "close",
      () => {
        pending = null;
        resolve(dlg.returnValue === "abort");
      },
      { once: true },
    );
  });
  dlg.showModal();
  return pending;
}

/** Close dialogs when the backdrop (the dialog element itself) is clicked. */
export function wireBackdropClose(dlg: HTMLDialogElement): void {
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
}

export function liveAnnounce(text: string): void {
  const el = document.getElementById("sr-live");
  if (!el) return;
  el.textContent = "";
  // Re-set on the next frame so identical consecutive messages are announced again.
  requestAnimationFrame(() => {
    el.textContent = text;
  });
}

export function notice(kind: "error" | "warn" | "info", body: Node | string, onClose?: () => void): HTMLElement {
  const close = h("button", { type: "button", class: "notice-close", "aria-label": "Dismiss message" }, "×");
  const box = h("div", { class: kind === "info" ? "notice" : `notice ${kind}`, role: kind === "error" ? "alert" : "status" }, h("div", null, body), close);
  close.addEventListener("click", () => {
    box.remove();
    onClose?.();
  });
  return box;
}
