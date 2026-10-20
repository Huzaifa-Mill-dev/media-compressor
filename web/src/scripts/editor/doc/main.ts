/** /edit-document: wires the TipTap editor to the page shell (toolbar, file bar, dialogs, find, autosave). */
import { Editor } from "@tiptap/core";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyleKit } from "@tiptap/extension-text-style";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import { StarterKit } from "@tiptap/starter-kit";
import type { EditorView } from "@tiptap/pm/view";
import type { PageSize } from "./export-docx";
import { FindReplace, Indent, PageBreak, find } from "./extensions";
import { fileToHtml, ImportError, sanitizeHtml } from "./import";
import { runServerTool, serverHas } from "./server";

/** The DOCX writer is only needed on save/export, so it is its own chunk. */
const toDocx: typeof import("./export-docx").toDocx = async (...a) => (await import("./export-docx")).toDocx(...a);

const DRAFT_KEY = "mt:doc-editor:draft:v1";
const DEFAULT_NAME = "Untitled document";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

interface Draft {
  html: string;
  name: string;
  page: PageSize;
  at: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return typeof d.html === "string" ? d : null;
  } catch {
    return null;
  }
}
function removeDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable */
  }
}
function writeDraft(d: Draft): boolean {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    return true;
  } catch {
    return false;
  }
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const fileBase = (name: string) => name.replace(/\.[^.]+$/, "");
const safeFileName = (name: string) => (name.trim() || DEFAULT_NAME).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").slice(0, 100);
const readDataUrl = (f: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/** WAI-ARIA toolbar: one tab stop, arrow keys / Home / End move between controls, Esc returns to the page. */
function rovingToolbar(bar: HTMLElement, onEscape: () => void): void {
  const items = () =>
    [...bar.querySelectorAll<HTMLElement>("button, select, input")].filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
  const setCurrent = (el: HTMLElement) => {
    for (const it of bar.querySelectorAll<HTMLElement>("button, select, input")) it.tabIndex = it === el ? 0 : -1;
  };
  const first = items()[0];
  if (first) setCurrent(first);
  bar.addEventListener("focusin", (e) => setCurrent(e.target as HTMLElement));
  bar.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onEscape();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
    list[next]!.focus();
  });
  // Keep a reachable tab stop when the current item becomes disabled or hidden.
  const fix = () => {
    const list = items();
    if (!list.some((el) => el.tabIndex === 0) && list[0]) setCurrent(list[0]);
  };
  new MutationObserver(fix).observe(bar, { subtree: true, attributes: true, attributeFilter: ["disabled", "hidden"] });
}

export function start(app: HTMLElement): void {
  const mount = $("doc-editor");
  const page = $("doc-page");
  const toolbar = $("doc-toolbar");
  const tablebar = $("doc-tablebar");
  const nameInput = $<HTMLInputElement>("doc-name");
  const pageSize = $<HTMLSelectElement>("doc-page-size");
  const message = $("doc-message");
  const draftStatus = $("doc-draft");
  const count = $("doc-count");
  const fileInput = $<HTMLInputElement>("doc-file-input");
  const imageInput = $<HTMLInputElement>("doc-image-input");
  const styleSel = $<HTMLSelectElement>("tb-style");
  const sizeSel = $<HTMLSelectElement>("tb-size");
  const colorIn = $<HTMLInputElement>("tb-color");
  const colorSwatch = $("tb-color-swatch");
  const hlSel = $<HTMLSelectElement>("tb-highlight");

  mount.replaceChildren();

  // The formatting toolbar sticks just below the site header (which is itself sticky and wraps on small screens).
  const header = document.querySelector<HTMLElement>("body > header");
  if (header) {
    const place = () => app.style.setProperty("--sticky-top", getComputedStyle(header).position === "sticky" ? `${header.offsetHeight}px` : "0px");
    new ResizeObserver(place).observe(header);
  }

  let dirty = false;
  let autosave = true;
  let busy: AbortController | null = null;

  const say = (text: string, kind: "info" | "error" = "info") => {
    message.textContent = text;
    message.dataset.kind = kind;
  };

  const editor = new Editor({
    element: mount,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
          protocols: ["mailto", "tel"],
          HTMLAttributes: { rel: "noopener noreferrer nofollow", target: null },
        },
      }),
      TextStyleKit.configure({ backgroundColor: false, fontFamily: false, lineHeight: false }),
      TextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right", "justify"] }),
      Highlight.configure({ multicolor: true }),
      Image.configure({ allowBase64: true, inline: false }),
      TableKit.configure({ table: { resizable: false } }),
      CharacterCount,
      Placeholder.configure({ placeholder: "Start typing, or open a document…" }),
      PageBreak,
      Indent,
      FindReplace,
    ],
    content: "<p></p>",
    editorProps: {
      attributes: {
        class: "doc-content",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Document",
        spellcheck: "true",
      },
      transformPastedHTML: sanitizeHtml,
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => IMAGE_TYPES.test(f.type));
        if (!files.length) return false;
        void insertImages(files);
        return true;
      },
      handleDrop: (view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (!files.length) return false;
        const images = files.filter((f) => IMAGE_TYPES.test(f.type));
        if (images.length) {
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          void insertImages(images, pos);
        } else void openFile(files[0]!);
        event.preventDefault();
        return true;
      },
    },
  });
  const view = (): EditorView => editor.view;

  async function insertImages(files: File[], at?: number) {
    for (const f of files) {
      const src = await readDataUrl(f);
      const node = { type: "image", attrs: { src, alt: fileBase(f.name) } };
      if (typeof at === "number") editor.chain().insertContentAt(at, node).run();
      else editor.chain().focus().insertContent(node).run();
    }
  }

  // ─── Toolbar ────────────────────────────────────────────────────────────────────────────
  const fromPointer = new WeakSet<Event>();
  /** Pointer clicks return focus to the page; keyboard activation keeps focus in the toolbar. */
  const chain = (e?: Event) => (e && fromPointer.has(e) ? editor.chain().focus() : editor.chain());

  const tableCmd: Record<string, () => boolean> = {
    "row-before": () => chain().addRowBefore().run(),
    "row-after": () => chain().addRowAfter().run(),
    "row-delete": () => chain().deleteRow().run(),
    "col-before": () => chain().addColumnBefore().run(),
    "col-after": () => chain().addColumnAfter().run(),
    "col-delete": () => chain().deleteColumn().run(),
    "header-row": () => chain().toggleHeaderRow().run(),
    merge: () => chain().mergeCells().run(),
    split: () => chain().splitCell().run(),
    "table-delete": () => editor.chain().focus().deleteTable().run(),
  };
  const canTable: Record<string, () => boolean> = {
    "row-before": () => editor.can().addRowBefore(),
    "row-after": () => editor.can().addRowAfter(),
    "row-delete": () => editor.can().deleteRow(),
    "col-before": () => editor.can().addColumnBefore(),
    "col-after": () => editor.can().addColumnAfter(),
    "col-delete": () => editor.can().deleteColumn(),
    "header-row": () => editor.can().toggleHeaderRow(),
    merge: () => editor.can().mergeCells(),
    split: () => editor.can().splitCell(),
    "table-delete": () => editor.can().deleteTable(),
  };

  function run(cmd: string, e?: Event): void {
    const c = chain(e);
    switch (cmd) {
      case "undo":
        c.undo().run();
        break;
      case "redo":
        c.redo().run();
        break;
      case "bold":
        c.toggleBold().run();
        break;
      case "italic":
        c.toggleItalic().run();
        break;
      case "underline":
        c.toggleUnderline().run();
        break;
      case "strike":
        c.toggleStrike().run();
        break;
      case "clear":
        c.unsetAllMarks().run();
        break;
      case "align-left":
      case "align-center":
      case "align-right":
      case "align-justify":
        c.setTextAlign(cmd.slice(6)).run();
        break;
      case "bullets":
        c.toggleBulletList().run();
        break;
      case "numbers":
        c.toggleOrderedList().run();
        break;
      case "indent":
        if (editor.can().sinkListItem("listItem")) c.sinkListItem("listItem").run();
        else c.indent().run();
        break;
      case "outdent":
        if (editor.can().liftListItem("listItem")) c.liftListItem("listItem").run();
        else c.outdent().run();
        break;
      case "link":
        openLinkDialog();
        break;
      case "image":
        imageInput.click();
        break;
      case "table":
        openTableDialog();
        break;
      case "page-break":
        c.setPageBreak().run();
        break;
      case "find":
        if (findPanel.hidden) openFind();
        else closeFind();
        break;
      default:
        tableCmd[cmd]?.();
    }
  }

  for (const bar of [toolbar, tablebar]) {
    bar.addEventListener("mousedown", (e) => {
      // Keep the editor focused (and its selection visible) when a toolbar button is clicked.
      if ((e.target as HTMLElement).closest("button")) e.preventDefault();
    });
    bar.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-cmd]");
      if (!btn) return;
      if (e.detail > 0) fromPointer.add(e);
      run(btn.dataset.cmd!, e);
    });
    rovingToolbar(bar, () => editor.commands.focus());
  }

  styleSel.addEventListener("change", () => {
    const v = styleSel.value;
    const c = editor.chain();
    if (v !== "blockquote" && editor.isActive("blockquote")) c.lift("blockquote");
    if (v === "paragraph") c.setParagraph();
    else if (/^h[1-6]$/.test(v)) c.setHeading({ level: Number(v[1]) as 1 | 2 | 3 | 4 | 5 | 6 });
    else if (v === "blockquote") {
      c.setParagraph();
      if (!editor.isActive("blockquote")) c.setBlockquote();
    } else if (v === "codeBlock") c.setCodeBlock();
    c.run();
  });
  sizeSel.addEventListener("change", () => {
    if (sizeSel.value) editor.chain().setFontSize(sizeSel.value).run();
    else editor.chain().unsetFontSize().run();
  });
  colorIn.addEventListener("input", () => {
    editor.chain().setColor(colorIn.value).run();
    colorSwatch.style.background = colorIn.value;
  });
  hlSel.addEventListener("change", () => {
    if (hlSel.value === "none") editor.chain().unsetHighlight().run();
    else if (hlSel.value) editor.chain().setHighlight({ color: hlSel.value }).run();
    hlSel.value = "";
  });

  const pressed = (cmd: string, on: boolean) => toolbar.querySelector(`[data-cmd="${cmd}"]`)?.setAttribute("aria-pressed", String(on));
  const disable = (cmd: string, off: boolean) => {
    const b = app.querySelector<HTMLButtonElement>(`[data-cmd="${cmd}"]`);
    if (b) b.disabled = off;
  };

  function syncToolbar(): void {
    pressed("bold", editor.isActive("bold"));
    pressed("italic", editor.isActive("italic"));
    pressed("underline", editor.isActive("underline"));
    pressed("strike", editor.isActive("strike"));
    pressed("bullets", editor.isActive("bulletList"));
    pressed("numbers", editor.isActive("orderedList"));
    pressed("link", editor.isActive("link"));
    const align = (["center", "right", "justify"] as const).find((a) => editor.isActive({ textAlign: a })) ?? "left";
    for (const a of ["left", "center", "right", "justify"]) pressed(`align-${a}`, a === align);
    disable("undo", !editor.can().undo());
    disable("redo", !editor.can().redo());

    const level = editor.getAttributes("heading").level as number | undefined;
    styleSel.value = editor.isActive("codeBlock") ? "codeBlock" : editor.isActive("heading") && level ? `h${level}` : editor.isActive("blockquote") ? "blockquote" : "paragraph";
    const size = editor.getAttributes("textStyle").fontSize as string | undefined;
    sizeSel.value = size && [...sizeSel.options].some((o) => o.value === size) ? size : "";
    const color = (editor.getAttributes("textStyle").color as string | undefined) ?? "";
    colorSwatch.style.background = color || "currentColor";

    const inTable = editor.isActive("table");
    tablebar.hidden = !inTable;
    if (inTable) for (const [cmd, can] of Object.entries(canTable)) disable(cmd, !can());
  }

  function syncCount(): void {
    const s = editor.storage.characterCount as { words: () => number; characters: () => number };
    const w = s.words();
    count.textContent = `${w.toLocaleString()} word${w === 1 ? "" : "s"} · ${s.characters().toLocaleString()} characters`;
  }

  // ─── Page size ──────────────────────────────────────────────────────────────────────────
  const printStyle = document.createElement("style");
  document.head.append(printStyle);
  function setPage(p: PageSize): void {
    pageSize.value = p;
    page.dataset.page = p;
    printStyle.textContent = `@page { size: ${p === "letter" ? "letter" : "A4"}; margin: 1in; }`;
  }
  pageSize.addEventListener("change", () => {
    setPage(pageSize.value === "letter" ? "letter" : "a4");
    scheduleSave();
  });
  setPage("a4");

  // ─── Autosave ───────────────────────────────────────────────────────────────────────────
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function saveNow(): void {
    clearTimeout(saveTimer);
    if (!autosave) {
      draftStatus.textContent = "Autosave paused — restore or discard the earlier draft";
      return;
    }
    if (editor.isEmpty) {
      removeDraft();
      draftStatus.textContent = "";
      return;
    }
    const ok = writeDraft({ html: editor.getHTML(), name: nameInput.value, page: pageSize.value as PageSize, at: Date.now() });
    draftStatus.textContent = ok
      ? `Draft saved in this browser at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Couldn't autosave: the document is too large for browser storage. Save a DOCX copy.";
  }
  function scheduleSave(): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }
  addEventListener("pagehide", saveNow);
  nameInput.addEventListener("input", scheduleSave);

  const restore = $("doc-restore");
  const pending = readDraft();
  if (pending && pending.html.replace(/<[^>]*>/g, "").trim().length + (pending.html.match(/<img/g)?.length ?? 0) > 0) {
    autosave = false;
    const when = new Date(pending.at);
    $("doc-restore-text").textContent = `You have an unsaved draft${pending.name ? ` (“${pending.name}”)` : ""} from ${when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.`;
    restore.hidden = false;
    $("doc-restore-yes").addEventListener("click", () => {
      editor.commands.setContent(pending.html, { emitUpdate: false });
      nameInput.value = pending.name || DEFAULT_NAME;
      setPage(pending.page === "letter" ? "letter" : "a4");
      restore.hidden = true;
      autosave = true;
      dirty = true;
      afterLoad();
      say("Draft restored.");
      editor.commands.focus("start");
    });
    $("doc-restore-no").addEventListener("click", () => {
      removeDraft();
      restore.hidden = true;
      autosave = true;
      saveNow();
      say("Draft discarded.");
      editor.commands.focus();
    });
  }

  editor.on("update", () => {
    dirty = true;
    syncCount();
    scheduleSave();
  });
  editor.on("transaction", () => {
    syncToolbar();
    if (!findPanel.hidden) syncFindCount();
  });

  function afterLoad(): void {
    syncCount();
    syncToolbar();
    if (!findPanel.hidden) find.set(view(), { query: findQ.value, current: 0 });
  }

  // ─── Open / new / save ──────────────────────────────────────────────────────────────────
  const barButtons = [...app.querySelectorAll<HTMLButtonElement>(".doc-bar button")];
  function setBusy(on: boolean): AbortController | null {
    busy?.abort();
    busy = on ? new AbortController() : null;
    app.setAttribute("aria-busy", String(on));
    for (const b of barButtons) b.disabled = on;
    return busy;
  }

  const confirmReplace = (what: string) => !dirty || editor.isEmpty || confirm(`${what} The current document will be replaced. Its draft is kept only until you edit the new one.`);

  async function openFile(file: File): Promise<void> {
    if (!confirmReplace(`Open “${file.name}”?`)) return;
    const ctl = setBusy(true)!;
    say(`Opening ${file.name}…`);
    try {
      const { html, warnings } = await fileToHtml(
        file,
        (p) => say(`${p.stage === "uploading" ? "Uploading" : "Converting"} ${file.name}… ${Math.round(p.percent)}%`),
        ctl.signal,
      );
      editor.commands.setContent(html || "<p></p>", { emitUpdate: false });
      nameInput.value = fileBase(file.name) || DEFAULT_NAME;
      autosave = true;
      restore.hidden = true;
      dirty = false;
      afterLoad();
      saveNow();
      say(warnings.length ? `Opened ${file.name}. Some content couldn't be converted and was left out.` : `Opened ${file.name}.`);
      editor.commands.focus("start");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      console.error(e);
      say(e instanceof ImportError ? e.message : `Couldn't open ${file.name}: ${(e as Error).message || "the file may be damaged."}`, "error");
    } finally {
      if (busy === ctl) setBusy(false);
    }
  }

  $("doc-open").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (f) void openFile(f);
  });
  imageInput.addEventListener("change", () => {
    const files = [...(imageInput.files ?? [])];
    imageInput.value = "";
    void insertImages(files);
  });

  $("doc-new").addEventListener("click", () => {
    if (!confirmReplace("Start a new document?")) return;
    editor.commands.setContent("<p></p>", { emitUpdate: false });
    editor.commands.clearContent();
    nameInput.value = DEFAULT_NAME;
    autosave = true;
    restore.hidden = true;
    dirty = false;
    removeDraft();
    afterLoad();
    draftStatus.textContent = "";
    say("New document.");
    editor.commands.focus();
  });

  const exportOpts = () => ({ title: nameInput.value.trim() || DEFAULT_NAME, page: (pageSize.value === "letter" ? "letter" : "a4") as PageSize });

  $("doc-save-docx").addEventListener("click", async () => {
    const ctl = setBusy(true)!;
    say("Preparing DOCX…");
    try {
      const blob = await toDocx(editor.getJSON(), exportOpts());
      download(blob, `${safeFileName(nameInput.value)}.docx`);
      dirty = false;
      say("Saved as DOCX.");
    } catch (e) {
      console.error(e);
      say(`Couldn't create the DOCX: ${(e as Error).message}`, "error");
    } finally {
      if (busy === ctl) setBusy(false);
    }
  });

  $("doc-save-pdf").addEventListener("click", async () => {
    const ctl = setBusy(true)!;
    const usePrint = (why: string) => {
      say(`${why}Choose “Save as PDF” in the print dialog.`);
      window.print();
    };
    try {
      say("Checking PDF conversion…");
      if (!(await serverHas("document-convert"))) return usePrint("");
      const name = safeFileName(nameInput.value);
      const docx = new File([await toDocx(editor.getJSON(), exportOpts())], `${name}.docx`, { type: DOCX_MIME });
      const pdf = await runServerTool(
        "document-convert",
        docx,
        { format: "pdf" },
        (p) => say(`${p.stage === "uploading" ? "Uploading" : "Converting to PDF on our server"}… ${Math.round(p.percent)}% (deleted within 30 minutes)`),
        ctl.signal,
      );
      download(pdf, `${name}.pdf`);
      say("Exported as PDF.");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      console.error(e);
      usePrint("The PDF server couldn't convert this document. ");
    } finally {
      if (busy === ctl) setBusy(false);
    }
  });

  // Dropping a document anywhere on the editor area opens it (images dropped onto the page are inserted).
  const desk = $("doc-desk");
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  desk.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    desk.dataset.drag = "1";
  });
  desk.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      delete desk.dataset.drag;
    }
  });
  desk.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  desk.addEventListener("drop", (e) => {
    dragDepth = 0;
    delete desk.dataset.drag;
    if (e.defaultPrevented || !hasFiles(e)) return;
    e.preventDefault();
    const f = e.dataTransfer?.files[0];
    if (f) void (IMAGE_TYPES.test(f.type) ? insertImages([f]) : openFile(f));
  });

  // ─── Link & table dialogs ───────────────────────────────────────────────────────────────
  const linkDialog = $<HTMLDialogElement>("doc-link-dialog");
  const linkUrl = $<HTMLInputElement>("doc-link-url");
  function openLinkDialog(): void {
    linkUrl.value = (editor.getAttributes("link").href as string | undefined) ?? "";
    $("doc-link-remove").hidden = !editor.isActive("link");
    linkDialog.returnValue = "";
    linkDialog.showModal();
    linkUrl.select();
  }
  $("doc-link-form").addEventListener("submit", (e) => {
    let href = linkUrl.value.trim();
    if (!href) return e.preventDefault();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) href = /^[^\s@]+@[^\s@]+$/.test(href) ? `mailto:${href}` : `https://${href}`;
    if (!/^(https?|mailto|tel):/i.test(href)) {
      e.preventDefault();
      linkUrl.setCustomValidity("Use a web (https://), email or phone link.");
      linkUrl.reportValidity();
      return;
    }
    // Close first: focus can't return to the editor while the modal is open.
    e.preventDefault();
    linkDialog.close("ok");
    const { empty } = editor.state.selection;
    if (empty && !editor.isActive("link")) editor.chain().focus().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  });
  linkUrl.addEventListener("input", () => linkUrl.setCustomValidity(""));
  $("doc-link-remove").addEventListener("click", () => {
    linkDialog.close();
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
  });
  $("doc-link-cancel").addEventListener("click", () => linkDialog.close());
  linkDialog.addEventListener("close", () => {
    if (linkDialog.returnValue !== "ok") editor.commands.focus();
  });

  const tableDialog = $<HTMLDialogElement>("doc-table-dialog");
  function openTableDialog(): void {
    tableDialog.returnValue = "";
    tableDialog.showModal();
    $<HTMLInputElement>("doc-table-rows").select();
  }
  $("doc-table-form").addEventListener("submit", (e) => {
    e.preventDefault();
    tableDialog.close("ok");
    const n = (id: string, max: number) => Math.max(1, Math.min(max, Math.round(Number($<HTMLInputElement>(id).value) || 1)));
    editor
      .chain()
      .focus()
      .insertTable({ rows: n("doc-table-rows", 50), cols: n("doc-table-cols", 12), withHeaderRow: $<HTMLInputElement>("doc-table-header").checked })
      .run();
  });
  $("doc-table-cancel").addEventListener("click", () => tableDialog.close());
  tableDialog.addEventListener("close", () => {
    if (tableDialog.returnValue !== "ok") editor.commands.focus();
  });

  // ─── Find & replace ─────────────────────────────────────────────────────────────────────
  const findPanel = $("doc-find");
  const findQ = $<HTMLInputElement>("find-q");
  const findR = $<HTMLInputElement>("find-r");
  const findCase = $<HTMLInputElement>("find-case");
  const findCount = $("find-count");
  function syncFindCount(): void {
    const s = find.state(editor.state);
    findCount.textContent = !s?.query ? "" : s.matches.length ? `${s.current + 1} of ${s.matches.length}` : "No matches";
  }
  function openFind(): void {
    findPanel.hidden = false;
    pressed("find", true);
    const { from, to } = editor.state.selection;
    const sel = editor.state.doc.textBetween(from, to, " ");
    if (sel && sel.length < 100 && !sel.includes("\n")) findQ.value = sel;
    find.set(view(), { query: findQ.value, caseSensitive: findCase.checked, current: 0 });
    syncFindCount();
    findQ.focus();
    findQ.select();
  }
  function closeFind(): void {
    findPanel.hidden = true;
    pressed("find", false);
    find.set(view(), { query: "" });
    editor.commands.focus();
  }
  findQ.addEventListener("input", () => {
    find.set(view(), { query: findQ.value, current: 0 });
    syncFindCount();
  });
  findCase.addEventListener("change", () => {
    find.set(view(), { caseSensitive: findCase.checked, current: 0 });
    syncFindCount();
  });
  $("find-next").addEventListener("click", () => find.step(view(), 1));
  $("find-prev").addEventListener("click", () => find.step(view(), -1));
  $("find-replace").addEventListener("click", () => {
    find.replaceCurrent(view(), findR.value);
    syncFindCount();
  });
  $("find-replace-all").addEventListener("click", () => {
    const n = find.replaceAll(view(), findR.value);
    say(n ? `Replaced ${n} match${n === 1 ? "" : "es"}.` : "Nothing to replace.");
  });
  $("find-close").addEventListener("click", closeFind);
  findPanel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    } else if (e.key === "Enter" && e.target === findQ) {
      e.preventDefault();
      find.step(view(), e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter" && e.target === findR) {
      e.preventDefault();
      find.replaceCurrent(view(), findR.value);
    }
  });

  // ─── Shortcuts (only while focus is inside the editor app) ───────────────────────────────
  app.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.altKey && (k === "f" || k === "h")) {
      e.preventDefault();
      openFind();
    } else if (mod && !e.altKey && !e.shiftKey && k === "k" && view().hasFocus()) {
      e.preventDefault();
      openLinkDialog();
    } else if (mod && !e.altKey && !e.shiftKey && k === "s") {
      e.preventDefault();
      $("doc-save-docx").click();
    } else if (e.altKey && e.key === "F10") {
      e.preventDefault();
      toolbar.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    }
  });

  afterLoad();
  app.dataset.state = "ready";
  if (import.meta.env.PUBLIC_TEST_HOOKS === "1") (window as unknown as { __docEditor: Editor }).__docEditor = editor;
}
