declare module "wawoff2/compress.js" {
  const f: (b: Uint8Array) => Promise<Uint8Array>;
  export default f;
}
declare module "wawoff2/decompress.js" {
  const f: (b: Uint8Array) => Promise<Uint8Array>;
  export default f;
}
declare module "pdfjs-dist/build/pdf.mjs" {
  export * from "pdfjs-dist";
}
declare module "pdfjs-dist/build/pdf.worker.min.mjs?url" {
  const url: string;
  export default url;
}
