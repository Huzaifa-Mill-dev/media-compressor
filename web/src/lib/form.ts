/**
 * Generic option-form renderer: builds controls from `ToolDefinition.options` alone.
 * The only special presentation is a `select` whose key is "profile", rendered as the
 * radio "profile pills" from the original compressor UI (still a plain radio group).
 */
import type { OptionField, Options, ToolDefinition } from "../../../engine/src/types.ts";
import { h, icon, ICONS } from "./dom";

export interface OptionsForm {
  root: HTMLElement;
  /** Current values merged over defaults; hidden (showIf=false) fields keep their default. */
  values(): Options;
  /** Validate inputs; returns a list of human-readable problems (empty = valid). */
  validate(): string[];
  /** Re-evaluate showIf visibility. */
  refresh(): void;
}

export function defaultsOf(tool: ToolDefinition): Options {
  const out: Options = {};
  for (const f of tool.options) out[f.key] = f.default;
  return out;
}

const PILL_ICONS: Record<string, readonly string[]> = {
  "quality-safe": ICONS.shield,
  "web-stream": ICONS.bolt,
  av1: ICONS.rocket,
  custom: ICONS.sliders,
};

/** "Quality-safe (H.264, native resolution)" → ["Quality-safe", "H.264, native resolution"] */
function splitLabel(label: string): [string, string] {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(label);
  return m ? [m[1]!, m[2]!] : [label, ""];
}

interface Control {
  field: OptionField;
  wrap: HTMLElement;
  read(): string | number | boolean | undefined;
  input?: HTMLInputElement;
}

export function renderOptionsForm(tool: ToolDefinition, idPrefix: string, onChange?: () => void): OptionsForm {
  const grid = h("div", { class: "options-grid" });
  const stack = h("div", { class: "options-stack" });
  const controls: Control[] = [];

  for (const field of tool.options) {
    const id = `${idPrefix}-${field.key}`;
    const helpId = field.help ? `${id}-help` : undefined;
    const help = field.help ? h("p", { class: "option-help", id: helpId }, field.help) : null;
    let ctl: Control;

    switch (field.type) {
      case "select": {
        if (field.key === "profile") {
          const fs = h("fieldset", { class: "profile-pills", "data-field": field.key, "aria-describedby": helpId });
          fs.appendChild(h("legend", null, field.label));
          for (const choice of field.choices) {
            const [title, desc] = splitLabel(choice.label);
            const input = h("input", {
              type: "radio",
              name: id,
              value: choice.value,
              checked: choice.value === field.default,
              "data-key": field.key,
            });
            const iconPaths = PILL_ICONS[choice.value];
            fs.appendChild(
              h(
                "label",
                { class: "profile-pill", "data-value": choice.value },
                input,
                h("span", { class: "pill-title" }, iconPaths ? icon([...iconPaths], 16) : null, title),
                desc ? h("span", { class: "pill-desc" }, desc) : null,
                h("span", { class: "pill-active", "aria-hidden": "true" }, "ACTIVE"),
              ),
            );
          }
          const wrap = h("div", { class: "option-group wide", "data-option": field.key }, fs, help);
          ctl = {
            field,
            wrap,
            read: () => (fs.querySelector<HTMLInputElement>("input:checked")?.value ?? field.default),
          };
          stack.appendChild(wrap);
          controls.push(ctl);
          continue;
        }
        const select = h("select", { id, name: field.key, "data-key": field.key, "aria-describedby": helpId });
        for (const c of field.choices) {
          select.appendChild(h("option", { value: c.value, selected: c.value === field.default }, c.label));
        }
        const wrap = h("div", { class: "option-group", "data-option": field.key }, h("label", { for: id }, field.label), select, help);
        ctl = { field, wrap, read: () => select.value };
        break;
      }
      case "range": {
        const step = field.step ?? 1;
        const out = h("output", { class: "option-val", for: id, id: `${id}-val` }, formatRange(field.default, field.unit));
        const input = h("input", {
          type: "range",
          id,
          name: field.key,
          min: field.min,
          max: field.max,
          step,
          value: field.default,
          "data-key": field.key,
          "aria-describedby": helpId,
        });
        input.addEventListener("input", () => {
          out.textContent = formatRange(Number(input.value), field.unit);
          input.setAttribute("aria-valuetext", out.textContent);
        });
        const wrap = h(
          "div",
          { class: "option-group", "data-option": field.key },
          h("label", { for: id }, field.label, out),
          input,
          h("div", { class: "range-labels", "aria-hidden": "true" }, h("span", null, formatRange(field.min, field.unit)), h("span", null, formatRange(field.max, field.unit))),
          help,
        );
        ctl = { field, wrap, input, read: () => Number(input.value) };
        break;
      }
      case "number": {
        const input = h("input", {
          type: "number",
          id,
          name: field.key,
          inputmode: "numeric",
          min: field.min,
          max: field.max,
          step: "any",
          placeholder: field.placeholder ?? (field.default !== undefined ? String(field.default) : undefined),
          value: field.default,
          "data-key": field.key,
          "aria-describedby": helpId,
        });
        const wrap = h(
          "div",
          { class: "option-group", "data-option": field.key },
          h("label", { for: id }, field.label, field.default === undefined ? h("span", { class: "option-hint" }, "(optional)") : null),
          input,
          help,
        );
        ctl = {
          field,
          wrap,
          input,
          read: () => {
            if (input.value.trim() === "") return field.default;
            const n = Number(input.value);
            return Number.isFinite(n) ? n : field.default;
          },
        };
        break;
      }
      case "toggle": {
        const input = h("input", { type: "checkbox", id, name: field.key, role: "switch", checked: field.default, "data-key": field.key, "aria-describedby": helpId });
        const wrap = h(
          "div",
          { class: "option-group", "data-option": field.key },
          h("label", { class: "toggle-control", for: id }, input, h("span", { class: "toggle-slider", "aria-hidden": "true" }), h("span", { class: "toggle-label" }, field.label)),
          help,
        );
        ctl = { field, wrap, read: () => input.checked };
        break;
      }
      case "text": {
        const input = h("input", {
          type: "text",
          id,
          name: field.key,
          placeholder: field.placeholder,
          value: field.default ?? "",
          autocomplete: "off",
          spellcheck: "false",
          maxlength: 500,
          "data-key": field.key,
          "aria-describedby": helpId,
        });
        const wrap = h("div", { class: "option-group", "data-option": field.key }, h("label", { for: id }, field.label), input, help);
        ctl = { field, wrap, input, read: () => input.value };
        break;
      }
    }
    grid.appendChild(ctl.wrap);
    controls.push(ctl);
  }

  if (grid.childElementCount > 0) stack.appendChild(grid);

  const byKey = new Map(controls.map((c) => [c.field.key, c]));
  const visible = (c: Control, depth = 0): boolean => {
    const cond = c.field.showIf;
    if (!cond) return true;
    const dep = byKey.get(cond.key);
    if (!dep || depth > 10) return true;
    if (!visible(dep, depth + 1)) return false;
    const v = dep.read();
    return cond.equals.some((e) => String(e) === String(v));
  };

  const refresh = () => {
    for (const c of controls) {
      const show = visible(c);
      c.wrap.hidden = !show;
      for (const el of c.wrap.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select")) el.disabled = !show;
    }
  };

  stack.addEventListener("input", () => {
    refresh();
    onChange?.();
  });
  stack.addEventListener("change", () => {
    refresh();
    onChange?.();
  });
  refresh();

  return {
    root: stack,
    refresh,
    values() {
      const out = defaultsOf(tool);
      for (const c of controls) {
        if (!visible(c)) continue;
        out[c.field.key] = c.read();
      }
      return out;
    },
    validate() {
      const problems: string[] = [];
      for (const c of controls) {
        if (!visible(c) || !c.input) continue;
        const ok = c.input.checkValidity();
        c.input.setAttribute("aria-invalid", ok ? "false" : "true");
        if (!ok) {
          const f = c.field;
          const range =
            f.type === "number" && (f.min !== undefined || f.max !== undefined)
              ? ` (allowed: ${f.min ?? "…"}–${f.max ?? "…"})`
              : "";
          problems.push(`${f.label}: please enter a valid value${range}.`);
        }
      }
      return problems;
    },
  };
}

function formatRange(v: number, unit?: string): string {
  return unit ? `${v} ${unit}` : String(v);
}
