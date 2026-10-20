/** Turn a user image into bytes pdf-lib can embed (PNG or JPEG), upright as the browser shows it. */
import type { Asset } from "./model";

export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

function sniff(b: Uint8Array): "png" | "jpg" | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  return null;
}

/** EXIF orientation of a JPEG (1 = upright). pdf-lib embeds raw pixels, so rotated photos must be re-encoded. */
export function jpegOrientation(b: Uint8Array): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 2;
  while (p + 4 < b.length) {
    if (b[p] !== 0xff) return 1;
    const marker = b[p + 1]!;
    const len = v.getUint16(p + 2);
    if (marker === 0xe1 && v.getUint32(p + 4) === 0x45786966) {
      const t = p + 10;
      const le = v.getUint16(t) === 0x4949;
      const ifd = t + v.getUint32(t + 4, le);
      const n = v.getUint16(ifd, le);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 10 > b.length) return 1;
        if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le);
      }
      return 1;
    }
    if (marker === 0xda) return 1;
    p += 2 + len;
  }
  return 1;
}

export async function readImage(file: Blob): Promise<Asset> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error("That image is larger than 40 MB.");
  let bytes = new Uint8Array(await file.arrayBuffer());
  let type = sniff(bytes);
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([bytes]));
  } catch {
    throw new Error("That file isn't an image this browser can read. Use PNG or JPG.");
  }
  let orientation = 1;
  try {
    if (type === "jpg") orientation = jpegOrientation(bytes);
  } catch {
    orientation = 1;
  }
  if (!type || orientation > 1) {
    // createImageBitmap already applied EXIF orientation; re-encode those pixels.
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    const out = type === "jpg" ? "jpg" : "png";
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, out === "jpg" ? "image/jpeg" : "image/png", 0.92));
    if (!blob) throw new Error("Couldn't convert that image.");
    bytes = new Uint8Array(await blob.arrayBuffer());
    type = out;
  }
  const width = bmp.width;
  const height = bmp.height;
  bmp.close();
  const url = URL.createObjectURL(new Blob([bytes], { type: type === "png" ? "image/png" : "image/jpeg" }));
  return { bytes, type, url, width, height };
}
