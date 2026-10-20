/** mammoth's prebuilt browser bundle (no Node built-ins) shares the package's typings. */
declare module "mammoth/mammoth.browser.js" {
  import mammoth from "mammoth";
  export default mammoth;
}
