import type { OptionField, Options, ToolDefinition } from "./types";
import { EngineError } from "./errors";

export function defaultsFor(tool: ToolDefinition): Options {
  const out: Options = {};
  for (const f of tool.options) {
    if ("default" in f && f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

function coerce(field: OptionField, raw: unknown): string | number | boolean | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return "default" in field ? field.default : undefined;
  }
  switch (field.type) {
    case "select": {
      const v = String(raw);
      if (!field.choices.some((c) => c.value === v)) {
        throw new EngineError("bad-option", `Invalid value for "${field.label}": ${v.slice(0, 40)}`);
      }
      return v;
    }
    case "range":
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new EngineError("bad-option", `"${field.label}" must be a number.`);
      const min = field.min ?? -Infinity;
      const max = field.max ?? Infinity;
      if (n < min || n > max) {
        throw new EngineError("bad-option", `"${field.label}" must be between ${field.min} and ${field.max}.`);
      }
      return n;
    }
    case "toggle":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === 1 || raw === "1") return true;
      if (raw === "false" || raw === 0 || raw === "0") return false;
      throw new EngineError("bad-option", `"${field.label}" must be true or false.`);
    case "text": {
      const s = String(raw);
      if (s.length > 1000) throw new EngineError("bad-option", `"${field.label}" is too long.`);
      return s;
    }
  }
}

/**
 * Merge user options over defaults, coerce types and validate against the tool's schema.
 * Unknown keys are dropped (never forwarded to processors or the server).
 */
export function normalizeOptions(tool: ToolDefinition, input: Options | undefined): Options {
  const out: Options = {};
  for (const f of tool.options) {
    const v = coerce(f, input?.[f.key]);
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}

/** Validate that a value is acceptable for a field (used by registry integrity tests). */
export function isValidValue(field: OptionField, v: unknown): boolean {
  try {
    const r = coerce(field, v);
    return r === undefined ? !("default" in field) || field.default === undefined : true;
  } catch {
    return false;
  }
}
