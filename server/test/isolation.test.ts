import { describe, expect, it } from "vitest";
import type { Binaries } from "../src/probe.js";
import { availableTools, SERVER_TOOLS, toolAvailable } from "../src/tools.js";

const bins = (over: Partial<Binaries>): Binaries => ({
  ffmpeg: true, ffprobe: true, gs: true, qpdf: true, soffice: true, fonttools: true,
  prlimit: null, heifDec: null, netIsolation: false, officeSafe: false, encoders: new Set(), versions: {},
  ...over,
});

/** LibreOffice runs attacker-authored documents (WEBSERVICE(), linked images…): never without network isolation. */
describe("LibreOffice fails closed without network isolation", () => {
  it("withholds document/spreadsheet tools when isolation is unavailable", () => {
    const ids = availableTools(bins({}));
    expect(ids).not.toContain("document-convert");
    expect(ids).not.toContain("spreadsheet-convert");
    expect(ids).toContain("pdf-compress"); // unrelated tools are unaffected
  });
  it("offers them when isolation works or the operator explicitly opts in", () => {
    for (const b of [bins({ netIsolation: true, officeSafe: true }), bins({ netIsolation: false, officeSafe: true })]) {
      expect(toolAvailable(SERVER_TOOLS["document-convert"], b)).toBe(true);
      expect(toolAvailable(SERVER_TOOLS["spreadsheet-convert"], b)).toBe(true);
    }
  });
  it("still requires the soffice binary itself", () => {
    expect(toolAvailable(SERVER_TOOLS["document-convert"], bins({ soffice: false, officeSafe: true }))).toBe(false);
  });
});
