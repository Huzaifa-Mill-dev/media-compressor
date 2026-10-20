/**
 * Interactive editors. They don't fit the Engine.run job model, so they live outside the tool registry as
 * dedicated pages, but they are listed with the registry tools of their category (home page, category pages).
 */
import type { Category } from "../../../engine/src/types.ts";

export interface EditorPage {
  slug: string;
  /** Link text / H1. */
  short: string;
  /** <title> prefix. */
  title: string;
  category: Category;
  description: string;
}

export const EDITORS: EditorPage[] = [
  {
    slug: "edit-pdf",
    short: "Edit PDF",
    title: "Edit PDF Online — Add Text, Images, Shapes & Signatures",
    category: "pdf",
    description:
      "Edit PDFs in your browser: add text, white-out, images, shapes, highlights, drawings and signatures, then rotate, reorder or delete pages. Nothing is uploaded.",
  },
];

export const editorsIn = (category: Category): EditorPage[] => EDITORS.filter((e) => e.category === category);
