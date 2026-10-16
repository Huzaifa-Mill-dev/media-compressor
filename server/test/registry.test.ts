import { describe, expect, it } from "vitest";
import { SERVER_TOOLS } from "../src/tools.js";

// Loaded dynamically: the engine sources use bundler-style extensionless imports that the server tsconfig (NodeNext) cannot follow.
const engineTools = ((await import("../../engine/src/tools" as string)) as { tools: any[] }).tools;

/** The engine registry and the server allowlist must not drift apart. */
describe("engine ↔ server registry", () => {
  it("same tool ids", () => {
    expect(Object.keys(SERVER_TOOLS).sort()).toEqual(engineTools.map((t: any) => t.id).sort());
  });
  for (const et of engineTools) {
    describe(et.id, () => {
      const st = SERVER_TOOLS[et.id as keyof typeof SERVER_TOOLS];
      it("multiInput agrees", () => expect(st.multiInput).toBe(et.multiInput));
      it("server accepts every extension the engine accepts (json is browser-only)", () => {
        for (const ext of et.accepts) if (ext !== "json") expect(st.accepts, ext).toContain(ext);
      });
      it("option keys match", () => expect(Object.keys(st.options).sort()).toEqual(et.options.map((o: any) => o.key).sort()));
      it("select values match", () => {
        for (const o of et.options as any[]) {
          const s = st.options[o.key]!;
          if (o.type === "select") {
            expect(s.t).toBe("select");
            if (s.t === "select") expect([...s.values].sort(), o.key).toEqual(o.choices.map((c: any) => c.value).sort());
          }
          if (o.type === "range" && s.t === "range") {
            expect(s.min, `${o.key} min`).toBe(o.min);
            expect(s.max, `${o.key} max`).toBe(o.max);
          }
        }
      });
      it("engine defaults are accepted by the server", () => {
        for (const o of et.options as any[]) {
          const s = st.options[o.key]!;
          if (o.type === "select" && s.t === "select") expect(s.values).toContain(o.default);
          if (o.type === "range" && s.t === "range") expect(o.default).toBeGreaterThanOrEqual(s.min);
        }
      });
    });
  }
});
