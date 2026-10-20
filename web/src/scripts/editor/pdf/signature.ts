/** Signature dialog: draw (captured as vector strokes) or type (becomes italic Times text). */
export type Signature = { kind: "ink"; strokes: [number, number][][]; color: string; padWidth: number } | { kind: "text"; text: string; color: string };

export function wireSignatureDialog(onInsert: (s: Signature) => void): { open: () => void } {
  const dlg = document.getElementById("pdfed-sign-dialog") as HTMLDialogElement;
  const pad = document.getElementById("pdfed-sign-pad") as HTMLCanvasElement;
  const tabDraw = document.getElementById("pdfed-tab-draw") as HTMLButtonElement;
  const tabType = document.getElementById("pdfed-tab-type") as HTMLButtonElement;
  const panelDraw = document.getElementById("pdfed-panel-draw") as HTMLElement;
  const panelType = document.getElementById("pdfed-panel-type") as HTMLElement;
  const textIn = document.getElementById("pdfed-sign-text") as HTMLInputElement;
  const preview = document.getElementById("pdfed-sign-preview") as HTMLElement;
  const colorIn = document.getElementById("pdfed-sign-color") as HTMLInputElement;
  const insertBtn = document.getElementById("pdfed-sign-insert") as HTMLButtonElement;
  const g = pad.getContext("2d")!;
  let strokes: [number, number][][] = [];
  let mode: "draw" | "type" = "draw";

  const redraw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = pad.clientWidth || 480;
    const h = pad.clientHeight || 180;
    if (pad.width !== Math.round(w * dpr)) {
      pad.width = Math.round(w * dpr);
      pad.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = "rgba(127,127,127,0.5)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(16, h - 36);
    g.lineTo(w - 16, h - 36);
    g.stroke();
    g.strokeStyle = colorIn.value;
    g.lineWidth = 2.5;
    g.lineCap = "round";
    g.lineJoin = "round";
    for (const s of strokes) {
      g.beginPath();
      s.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      if (s.length === 1) g.lineTo(s[0]![0] + 0.1, s[0]![1]);
      g.stroke();
    }
  };
  const syncInsert = () => {
    insertBtn.disabled = mode === "draw" ? strokes.length === 0 : textIn.value.trim() === "";
    preview.textContent = textIn.value || "Your name";
    preview.style.color = colorIn.value;
  };

  const select = (m: "draw" | "type") => {
    mode = m;
    tabDraw.setAttribute("aria-selected", String(m === "draw"));
    tabType.setAttribute("aria-selected", String(m === "type"));
    tabDraw.tabIndex = m === "draw" ? 0 : -1;
    tabType.tabIndex = m === "type" ? 0 : -1;
    panelDraw.hidden = m !== "draw";
    panelType.hidden = m !== "type";
    if (m === "draw") redraw();
    else textIn.focus();
    syncInsert();
  };
  tabDraw.addEventListener("click", () => select("draw"));
  tabType.addEventListener("click", () => select("type"));
  for (const t of [tabDraw, tabType])
    t.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const next = t === tabDraw ? tabType : tabDraw;
      next.focus();
      select(next === tabDraw ? "draw" : "type");
    });

  let drawing: [number, number][] | null = null;
  const at = (e: PointerEvent): [number, number] => {
    const r = pad.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  pad.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    drawing = [at(e)];
    strokes.push(drawing);
    redraw();
  });
  pad.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    for (const ce of e.getCoalescedEvents?.() ?? [e]) drawing.push(at(ce));
    redraw();
  });
  const end = () => {
    drawing = null;
    syncInsert();
  };
  pad.addEventListener("pointerup", end);
  pad.addEventListener("pointercancel", end);
  document.getElementById("pdfed-sign-clear")!.addEventListener("click", () => {
    strokes = [];
    redraw();
    syncInsert();
  });
  textIn.addEventListener("input", syncInsert);
  colorIn.addEventListener("input", () => {
    redraw();
    syncInsert();
  });
  textIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !insertBtn.disabled) {
      e.preventDefault();
      insertBtn.click();
    }
  });
  insertBtn.addEventListener("click", () => {
    if (mode === "draw" && strokes.length) onInsert({ kind: "ink", strokes, color: colorIn.value, padWidth: pad.clientWidth || 480 });
    else if (mode === "type" && textIn.value.trim()) onInsert({ kind: "text", text: textIn.value.trim(), color: colorIn.value });
    else return;
    dlg.close();
  });

  return {
    open: () => {
      strokes = [];
      dlg.showModal();
      select(mode);
      redraw();
      syncInsert();
    },
  };
}
