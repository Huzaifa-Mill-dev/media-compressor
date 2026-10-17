/**
 * Tiny DOM builder. Text children are always inserted as Text nodes, attributes via
 * setAttribute — never innerHTML — so user-controlled strings (filenames, errors,
 * metadata) can never become markup.
 */
type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) setAttrs(el, attrs);
  append(el, children);
  return el;
}

export function setAttrs(el: Element, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.setAttribute("class", String(v));
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
}

export function append(el: Node, children: (Child | Child[])[]): void {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Icon from static (developer-authored) path data. */
export function icon(paths: string[], size = 16, opts: { fill?: boolean; strokeWidth?: number } = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (opts.fill) {
    svg.setAttribute("fill", "currentColor");
  } else {
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", String(opts.strokeWidth ?? 2));
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
  }
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

export const ICONS = {
  x: ["M18 6 6 18", "M6 6l12 12"],
  retry: ["M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16", "M16 21h5v-5"],
  up: ["M18 15l-6-6-6 6"],
  down: ["M6 9l6 6 6-6"],
  grip: ["M9 5h.01", "M9 12h.01", "M9 19h.01", "M15 5h.01", "M15 12h.01", "M15 19h.01"],
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 6v6l4 2"],
  check: ["M20 6 9 17l-5-5"],
  arrow: ["M5 12h14", "M12 5l7 7-7 7"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5", "M12 15V3"],
  device: ["M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9H4z", "M2 18h20", "M8 21h8"],
  server: ["M3 4h18v6H3z", "M3 14h18v6H3z", "M7 7h.01", "M7 17h.01"],
  expand: ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"],
  play: ["M5 3l14 9-14 9z"],
  pause: ["M6 4h4v16H6z", "M14 4h4v16h-4z"],
  shield: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
  bolt: ["M13 2 3 14h9l-1 8 10-12h-9l1-8z"],
  rocket: [
    "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z",
    "m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z",
    "M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0",
    "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5",
  ],
  sliders: ["M4 21v-7", "M4 10V3", "M12 21v-9", "M12 8V3", "M20 21v-5", "M20 12V3", "M1 14h6", "M9 8h6", "M17 16h6"],
  file: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6"],
} as const satisfies Record<string, readonly string[]>;

export function iconOf(name: keyof typeof ICONS, size = 16, fill = false): SVGSVGElement {
  return icon([...ICONS[name]], size, { fill });
}
