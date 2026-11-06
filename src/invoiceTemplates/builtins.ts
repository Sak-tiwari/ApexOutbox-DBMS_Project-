import fs from "node:fs";
import path from "node:path";

/** Built-in templates live in templates/invoice/*.hbs (same folder from src/ and dist/). They cannot be edited or deleted. */
export const BUILTINS = [
  { id: "builtin:standard", file: "standard.hbs", name: "ApexOutbox Standard", note: "Clean layout with brand colour" },
  { id: "builtin:minimal", file: "minimal.hbs", name: "Minimal", note: "Lots of white space" },
  { id: "builtin:corporate", file: "corporate.hbs", name: "Corporate", note: "Colour band header" },
  { id: "builtin:gst", file: "gst.hbs", name: "GST Tax Invoice", note: "Indian tax invoice format with CGST/SGST/IGST" },
] as const;
export type BuiltinId = (typeof BUILTINS)[number]["id"];
export const BUILTIN_VERSION = 1;
export const FALLBACK_ID: BuiltinId = "builtin:standard";

const DIR = path.resolve(__dirname, "..", "..", "templates", "invoice");
const cache = new Map<string, string>();

export function isBuiltin(id: string): id is BuiltinId { return BUILTINS.some((b) => b.id === id); }
export function builtinSource(id: string): string {
  const b = BUILTINS.find((x) => x.id === id);
  if (!b) throw new Error(`Unknown built-in template ${id}`);
  if (!cache.has(id)) cache.set(id, fs.readFileSync(path.join(DIR, b.file), "utf8"));
  return cache.get(id)!;
}
/** "builtin:standard@1" */
export function builtinVersionId(id: string) { return `${id}@${BUILTIN_VERSION}`; }
export function parseBuiltinVersionId(v: string): string | null { const m = v.match(/^(builtin:[a-z-]+)@\d+$/); return m && isBuiltin(m[1]) ? m[1] : null; }
export function exampleTemplatePath() { return path.join(DIR, "example-all-placeholders.hbs"); }
