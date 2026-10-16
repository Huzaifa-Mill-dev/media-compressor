declare module "pdfjs-dist/build/pdf.mjs" {
  export * from "pdfjs-dist";
}
declare module "pdfjs-dist/build/pdf.worker.min.mjs?url" {
  const url: string;
  export default url;
}
