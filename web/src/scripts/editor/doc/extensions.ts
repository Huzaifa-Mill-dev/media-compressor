/** Custom TipTap extensions for the document editor: page breaks, paragraph indent, find & replace. */
import { Extension, Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageBreak: { setPageBreak: () => ReturnType };
    indent: { indent: () => ReturnType; outdent: () => ReturnType };
  }
}

/** A hard page break (Word `<w:br w:type="page"/>`). Printed as a CSS page break. */
export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML() {
    return [
      { tag: "div[data-page-break]", priority: 100 },
      { tag: "hr.page-break", priority: 100 },
    ];
  },
  renderHTML() {
    return ["div", { "data-page-break": "", class: "page-break", role: "separator", "aria-label": "Page break" }];
  },
  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ chain }) =>
          chain().insertContent({ type: this.name }).run(),
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-Enter": () => this.editor.commands.setPageBreak() };
  },
});

/** Inches per indent level; matches the 720-twip step used by the DOCX import/export. */
export const INDENT_STEP_IN = 0.5;
export const MAX_INDENT = 8;

/** Paragraph / heading left indent in 0.5in steps (lists use sink/lift instead). */
export const Indent = Extension.create({
  name: "indent",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el) => {
              const v = Number(el.getAttribute("data-indent"));
              return Number.isFinite(v) ? Math.max(0, Math.min(MAX_INDENT, Math.round(v))) : 0;
            },
            renderHTML: (attrs) => (attrs.indent ? { "data-indent": attrs.indent, style: `margin-left: ${attrs.indent * INDENT_STEP_IN}in` } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    const shift =
      (delta: number) =>
      () =>
      ({ tr, state, dispatch }: { tr: Transaction; state: EditorState; dispatch?: (tr: Transaction) => void }) => {
        let changed = false;
        const { from, to } = state.selection;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name !== "paragraph" && node.type.name !== "heading") return true;
          const next = Math.max(0, Math.min(MAX_INDENT, (node.attrs.indent as number) + delta));
          if (next !== node.attrs.indent) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
            changed = true;
          }
          return false;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      };
    return { indent: shift(1), outdent: shift(-1) };
  },
  addKeyboardShortcuts() {
    // Tab is left to the browser (focus navigation) outside lists, so the editor never traps keyboard users.
    return {
      "Mod-]": () => (this.editor.can().sinkListItem("listItem") ? this.editor.commands.sinkListItem("listItem") : this.editor.commands.indent()),
      "Mod-[": () => (this.editor.can().liftListItem("listItem") ? this.editor.commands.liftListItem("listItem") : this.editor.commands.outdent()),
    };
  },
});

// ─── Find & replace ───────────────────────────────────────────────────────────────────────────

export interface Match {
  from: number;
  to: number;
}
interface FindState {
  query: string;
  caseSensitive: boolean;
  matches: Match[];
  current: number;
  deco: DecorationSet;
}
export const findKey = new PluginKey<FindState>("find");

/** Text of each textblock with a char→position map, so matches may span differently-marked text nodes. */
export function findMatches(doc: PMNode, query: string, caseSensitive: boolean): Match[] {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: Match[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    let text = "";
    const pos: number[] = [];
    block.forEach((child, offset) => {
      const start = blockPos + 1 + offset;
      if (child.isText) {
        const t = child.text ?? "";
        for (let i = 0; i < t.length; i++) pos.push(start + i);
        text += t;
      } else {
        pos.push(start);
        text += "\uFFFC";
      }
    });
    const hay = caseSensitive ? text : text.toLowerCase();
    let i = hay.indexOf(needle);
    while (i !== -1) {
      out.push({ from: pos[i]!, to: pos[i + needle.length - 1]! + 1 });
      i = hay.indexOf(needle, i + needle.length);
    }
    return false;
  });
  return out;
}

function build(doc: PMNode, query: string, caseSensitive: boolean, current: number): FindState {
  const matches = findMatches(doc, query, caseSensitive);
  const cur = matches.length ? Math.min(Math.max(current, 0), matches.length - 1) : -1;
  const deco = DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === cur ? "find-hit current" : "find-hit" })),
  );
  return { query, caseSensitive, matches, current: cur, deco };
}

type FindMeta = Partial<Pick<FindState, "query" | "caseSensitive" | "current">>;

export const FindReplace = Extension.create({
  name: "findReplace",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ query: "", caseSensitive: false, matches: [], current: -1, deco: DecorationSet.empty }),
          apply(tr, prev) {
            const meta = tr.getMeta(findKey) as FindMeta | undefined;
            if (!meta && !tr.docChanged) return prev;
            const next = { ...prev, ...meta };
            return next.query ? build(tr.doc, next.query, next.caseSensitive, next.current) : { ...next, matches: [], current: -1, deco: DecorationSet.empty };
          },
        },
        props: { decorations: (state) => findKey.getState(state)?.deco },
      }),
    ];
  },
});

/** Imperative helpers the find panel calls. */
export const find = {
  state: (state: EditorState): FindState | undefined => findKey.getState(state),
  set(view: { state: EditorState; dispatch: (tr: Transaction) => void }, meta: FindMeta): void {
    view.dispatch(view.state.tr.setMeta(findKey, meta));
  },
  /** Move to the next/previous match relative to the current one, select it and scroll it into view. */
  step(view: { state: EditorState; dispatch: (tr: Transaction) => void }, dir: 1 | -1): void {
    const s = findKey.getState(view.state);
    if (!s || !s.matches.length) return;
    const n = s.matches.length;
    const current = s.current < 0 ? 0 : (s.current + dir + n) % n;
    const m = s.matches[current]!;
    view.dispatch(view.state.tr.setMeta(findKey, { current }).setSelection(TextSelection.create(view.state.doc, m.from, m.to)).scrollIntoView());
  },
  replaceCurrent(view: { state: EditorState; dispatch: (tr: Transaction) => void }, replacement: string): void {
    const s = findKey.getState(view.state);
    const m = s && s.current >= 0 ? s.matches[s.current] : undefined;
    if (!m) return;
    const tr = view.state.tr;
    if (replacement) tr.insertText(replacement, m.from, m.to);
    else tr.delete(m.from, m.to);
    view.dispatch(tr.setMeta(findKey, { current: s!.current }));
  },
  replaceAll(view: { state: EditorState; dispatch: (tr: Transaction) => void }, replacement: string): number {
    const s = findKey.getState(view.state);
    if (!s || !s.matches.length) return 0;
    const tr = view.state.tr;
    for (const m of [...s.matches].reverse()) {
      if (replacement) tr.insertText(replacement, m.from, m.to);
      else tr.delete(m.from, m.to);
    }
    view.dispatch(tr);
    return s.matches.length;
  },
};
