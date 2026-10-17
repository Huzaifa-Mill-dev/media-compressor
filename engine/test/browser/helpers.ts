import { createEngine, type EngineHandle } from "../../src/index";

export async function fixture(name: string, type = ""): Promise<File> {
  const r = await fetch(`/fixtures/${name}`);
  if (!r.ok) throw new Error(`missing fixture ${name}`);
  return new File([await r.arrayBuffer()], name, { type });
}
export const newEngine = (concurrency?: number): EngineHandle => createEngine({ concurrency, vendorBase: "/vendor/" });
export const head = async (b: Blob, n = 16) => new Uint8Array(await b.slice(0, n).arrayBuffer());
export const ascii = (u: Uint8Array) => String.fromCharCode(...u);
export async function dims(b: Blob) { const bm = await createImageBitmap(b); const r = { w: bm.width, h: bm.height }; bm.close(); return r; }
