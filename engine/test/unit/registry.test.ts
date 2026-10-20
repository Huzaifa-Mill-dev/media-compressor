import { describe, expect, it } from "vitest";
import { planJob, type BrowserEnv } from "../../src/routing";
import { getTool, tools } from "../../src/tools";
import type { ToolId } from "../../src/types";

const env: BrowserEnv = { webCodecs: true, wasm: true, workers: true, offscreenCanvas: true, crossOriginIsolated: true };
const pdf = [{ name: "a.pdf", size: 1000, head: new TextEncoder().encode("%PDF-1.7\n....") }];

describe("registry integrity", () => {
  it("has 16 unique tool ids and slugs", () => {
    expect(tools).toHaveLength(16);
    expect(new Set(tools.map((t) => t.id)).size).toBe(16);
    expect(new Set(tools.map((t) => t.slug)).size).toBe(16);
  });
  it.each(tools.map((t) => [t.id, t] as const))("%s: defaults valid and showIf refs exist", (_id, t) => {
    const keys = new Set(t.options.map((o) => o.key));
    expect(keys.size).toBe(t.options.length);
    for (const o of t.options) {
      if (o.showIf) expect(keys.has(o.showIf.key)).toBe(true);
      if (o.type === "select") expect(o.choices.map((c) => c.value)).toContain(o.default);
      if (o.type === "range") { expect(o.default).toBeGreaterThanOrEqual(o.min); expect(o.default).toBeLessThanOrEqual(o.max); }
    }
    expect(t.runtimes.length).toBeGreaterThan(0);
    expect(t.accepts.length).toBeGreaterThan(0);
  });
});

describe("routing", () => {
  it("server-only tool routes to server when available", () => {
    const t = getTool("compress-pdf")!;
    expect(planJob(t, pdf, {}, env, { tools: ["pdf-compress" as ToolId] })).toEqual({ runtime: "server" });
  });
  it("server-only tool returns null + reason when server lacks it / offline", () => {
    const t = getTool("compress-pdf")!;
    for (const s of [null, { tools: [] as ToolId[] }]) {
      const r = planJob(t, pdf, {}, env, s);
      expect(r.runtime).toBeNull();
      expect((r as { reason: string }).reason.length).toBeGreaterThan(5);
    }
  });
  it("browser-capable tool prefers browser", () => {
    const t = getTool("merge-pdf")!;
    expect(planJob(t, pdf, {}, env, null)).toEqual({ runtime: "browser" });
  });
});
