/** font-convert in the browser: TTF/OTF ↔ WOFF/WOFF2 wrapping. Outline conversion (TTF↔OTF) is server-only. */
import { EngineError } from "../errors";
import { extOf, fontFlavor, mimeOf, outName, sniff } from "../formats";
import type { ProcCtx, ProcResult } from "../protocol";
import { decodeWoff, encodeWoff, parseSfnt } from "./woff";

type Woff2Lib = { compress(b: Uint8Array): Promise<Uint8Array>; decompress(b: Uint8Array): Promise<Uint8Array> };
let woff2: Promise<Woff2Lib> | null = null;
async function loadWoff2(): Promise<Woff2Lib> {
  woff2 ??= (async () => {
    const c = (await import("wawoff2/compress.js")) as unknown as { default: Woff2Lib["compress"] };
    const d = (await import("wawoff2/decompress.js")) as unknown as { default: Woff2Lib["decompress"] };
    return { compress: c.default, decompress: d.default };
  })();
  return woff2;
}

/** Any supported font container → raw sfnt (TTF/OTF) bytes. */
export async function toSfnt(bytes: Uint8Array, name: string): Promise<{ sfnt: Uint8Array; flavor: "truetype" | "cff" }> {
  const kind = sniff(bytes);
  let sfnt: Uint8Array;
  try {
    if (kind === "woff") sfnt = decodeWoff(bytes);
    else if (kind === "woff2") sfnt = await (await loadWoff2()).decompress(bytes);
    else if (kind === "ttf" || kind === "otf") {
      parseSfnt(bytes); // validates directory + bounds
      sfnt = bytes;
    } else if (kind === "ttc") throw new EngineError("browser-unsupported", `${name} is a font collection (.ttc), which can't be converted in the browser.`);
    else throw new Error("unrecognised font header");
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError("corrupt", `${name} isn't a valid font file, or it is corrupt/truncated (${(e as Error).message}).`);
  }
  const flavor = fontFlavor(sfnt.subarray(0, 16));
  if (!flavor) throw new EngineError("corrupt", `${name} isn't a valid TrueType/OpenType font.`);
  return { sfnt, flavor };
}

export async function processFont(ctx: ProcCtx): Promise<ProcResult> {
  const file = ctx.files[0];
  if (!file) throw new EngineError("no-input", "No file selected.");
  const target = String(ctx.options.format ?? "woff2");
  ctx.progress("processing", 10, "Reading font");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) throw new EngineError("empty", `${file.name} is empty (0 bytes).`);
  const { sfnt, flavor } = await toSfnt(bytes, file.name);
  ctx.progress("processing", 50, "Converting");
  let out: Uint8Array;
  switch (target) {
    case "woff2": {
      try {
        out = await (await loadWoff2()).compress(sfnt);
      } catch (e) {
        throw new EngineError("corrupt", `Couldn't compress ${file.name} to WOFF2 (${(e as Error).message}).`);
      }
      break;
    }
    case "woff":
      out = encodeWoff(sfnt);
      break;
    case "ttf":
    case "otf": {
      const want = target === "ttf" ? "truetype" : "cff";
      if (flavor !== want) {
        throw new EngineError(
          "browser-unsupported",
          `Converting ${flavor === "cff" ? "OpenType (CFF)" : "TrueType"} outlines to ${target.toUpperCase()} needs our server.`,
        );
      }
      out = sfnt; // unwrap WOFF/WOFF2 or pass through
      break;
    }
    default:
      throw new EngineError("bad-option", `Unsupported font format "${target}".`);
  }
  const blob = new Blob([out as BlobPart], { type: mimeOf(target) });
  return {
    outputs: [{ blob, filename: outName(file.name, target), mime: mimeOf(target), size: blob.size }],
    meta: { codec: target, fromFormat: extOf(file.name), sfntFlavor: flavor },
  };
}
