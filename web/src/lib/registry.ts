/**
 * Build-time access to the tool registry (used by .astro pages for static generation).
 * Pure data — no browser APIs — so it is safe to evaluate in Node during `astro build`.
 */
import { tools as registryTools } from "../../../engine/src/tools.ts";
import type { Category, ToolDefinition } from "../../../engine/src/types.ts";

export const tools: ToolDefinition[] = registryTools;

export const CATEGORY_ORDER: Category[] = ["image", "video", "audio", "font", "pdf", "document", "spreadsheet"];

export function toolsByCategory(): { category: Category; tools: ToolDefinition[] }[] {
  return CATEGORY_ORDER.map((category) => ({ category, tools: tools.filter((t) => t.category === category) })).filter(
    (g) => g.tools.length > 0,
  );
}
