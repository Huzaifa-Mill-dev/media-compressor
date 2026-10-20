/**
 * Tiny entry for /edit-document: the editor (TipTap/ProseMirror, mammoth, docx) is a separate lazily-loaded
 * chunk, so the page shell paints first and no other page ever downloads it.
 */
const app = document.getElementById("doc-app");
if (app) {
  import("./main")
    .then((m) => m.start(app))
    .catch((e: unknown) => {
      console.error(e);
      app.dataset.state = "error";
      const loading = document.getElementById("doc-loading");
      if (loading) loading.textContent = "The editor couldn't load. Check your connection and reload the page.";
    });
}
