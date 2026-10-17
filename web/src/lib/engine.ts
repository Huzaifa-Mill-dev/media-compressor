/**
 * The single place the browser UI obtains an Engine.
 *
 * Production: the real engine from engine/src/index.ts (lazy-loaded so the tool page's
 * first paint does not wait for engine code).
 * Tests: when the site is built with PUBLIC_TEST_HOOKS=1 AND the page sets
 * `window.__MT_MOCK__`, the deterministic mock is used instead. In a normal build the
 * mock branch is dead code and is not shipped.
 */
import type { Engine } from "../../../engine/src/types.ts";

let enginePromise: Promise<Engine> | null = null;

export function getEngine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      if (import.meta.env.PUBLIC_TEST_HOOKS === "1" && (globalThis as { __MT_MOCK__?: unknown }).__MT_MOCK__) {
        const { createMockEngine } = await import("./engine-mock.ts");
        return createMockEngine();
      }
      const { createEngine } = await import("../../../engine/src/index.ts");
      return createEngine();
    })();
    // Allow a retry after a failed load (e.g. flaky network for a chunk).
    enginePromise.catch(() => {
      enginePromise = null;
    });
  }
  return enginePromise;
}
