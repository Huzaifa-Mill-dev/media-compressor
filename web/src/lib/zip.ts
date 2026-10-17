/** Build a ZIP of result files in the browser. fflate is loaded only when needed. */
export interface ZipEntry {
  name: string;
  blob: Blob;
}

/** Strip path components and control characters so ZIP entries can't escape the folder. */
export function safeEntryName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim();
  return cleaned || "file";
}

export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const n = safeEntryName(raw);
    if (!used.has(n.toLowerCase())) {
      used.add(n.toLowerCase());
      return n;
    }
    const dot = n.lastIndexOf(".");
    const stem = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : "";
    let i = 2;
    while (used.has(`${stem} (${i})${ext}`.toLowerCase())) i++;
    const out = `${stem} (${i})${ext}`;
    used.add(out.toLowerCase());
    return out;
  });
}

export async function buildZip(entries: ZipEntry[]): Promise<Blob> {
  const { zipSync } = await import("fflate");
  const names = uniqueNames(entries.map((e) => e.name));
  const files: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (let i = 0; i < entries.length; i++) {
    files[names[i]!] = [new Uint8Array(await entries[i]!.blob.arrayBuffer()), { level: 0 }];
  }
  // Outputs are already compressed media; store (level 0) is fastest and loses nothing.
  const data = zipSync(files);
  return new Blob([data as BlobPart], { type: "application/zip" });
}
