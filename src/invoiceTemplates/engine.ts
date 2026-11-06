import Handlebars from "handlebars";
import { IMAGE_FIELDS, ITEM_FIELDS, REQUIRED_FIELDS, TOP_LEVEL_FIELDS } from "./placeholders";
import { sanitizeTemplateHtml } from "./sanitize";
import type { ViewData } from "./viewModel";

/**
 * Templates use Handlebars syntax ({{client.name}}, {{#each items}}, {{#if tax.is_intra}}) in a locked-down
 * mode: only the built-in block helpers (if, unless, each, with), no custom helpers, no partials, no raw
 * output ({{{ }}} or {{& }}), no prototype access, and the data is a plain JSON copy.
 */
const hb = Handlebars.create();
const COMPILE_OPTS = { knownHelpersOnly: true, knownHelpers: { if: true, unless: true, each: true, with: true }, strict: false, noEscape: false, preventIndent: true } as const;
const BLOCKS = new Set(["if", "unless", "each", "with"]);

export interface ValidationIssue { level: "error" | "warning"; message: string }
export interface ValidationResult { ok: boolean; issues: ValidationIssue[]; fields: string[] }

/** Walks the Handlebars syntax tree and checks every field name against the placeholder list. */
export function validateTemplate(source: string, opts: { assetNames?: string[] } = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const used = new Set<string>();
  // Comments are documentation, not markup: ignore them for the text checks below.
  const code = source.replace(/\{\{!--[\s\S]*?--\}\}/g, "").replace(/\{\{![\s\S]*?\}\}/g, "").replace(/<!--[\s\S]*?-->/g, "");
  if (/\{\{\{|\{\{\s*&|\{\{\s*>|\{\{\s*#\s*>|\{\{\s*\*|\{\{\s*@partial/.test(code)) {
    issues.push({ level: "error", message: "Raw output ({{{ }}}, {{& }}) and partials ({{> }}) are not allowed. Use {{field}}." });
  }
  let ast: hbs.AST.Program;
  try {
    ast = hb.parse(source);
  } catch (e) {
    return { ok: false, issues: [{ level: "error", message: `Template syntax error: ${(e as Error).message.split("\n")[0]}` }], fields: [] };
  }

  const visit = (node: any, inItems: boolean) => {
    if (!node) return;
    switch (node.type) {
      case "Program": node.body.forEach((n: any) => visit(n, inItems)); break;
      case "MustacheStatement":
      case "SubExpression":
        checkPath(node.path, inItems, node.params?.length > 0);
        node.params?.forEach((p: any) => checkPath(p, inItems, false));
        break;
      case "BlockStatement": {
        const name = node.path.original;
        if (!BLOCKS.has(name)) { issues.push({ level: "error", message: `Unknown block helper "#${name}". Allowed: #if, #unless, #each, #with.` }); break; }
        node.params.forEach((p: any) => checkPath(p, inItems, false));
        const loopsItems = name === "each" && node.params[0]?.original === "items";
        if (name === "each" && !loopsItems) issues.push({ level: "error", message: `Only {{#each items}} can be looped over (found "${node.params[0]?.original}").` });
        visit(node.program, inItems || loopsItems);
        visit(node.inverse, inItems);
        break;
      }
      case "PartialStatement": case "PartialBlockStatement": case "DecoratorBlock": case "Decorator":
        issues.push({ level: "error", message: "Partials and decorators are not allowed." }); break;
      default: break;
    }
  };
  const checkPath = (p: any, inItems: boolean, hasParams: boolean) => {
    if (!p || p.type !== "PathExpression") return;
    if (hasParams) { issues.push({ level: "error", message: `"${p.original}" is used like a helper; helpers are not allowed.` }); return; }
    if (p.data) { if (!["index", "first", "last"].includes(p.parts[0])) issues.push({ level: "error", message: `Unknown @ variable "@${p.parts.join(".")}".` }); return; }
    const original: string = p.original.replace(/^\.\.\//, "").replace(/^this\./, "");
    if (p.original === "this" || p.original === ".") return;
    if (inItems && !p.original.startsWith("../") && ITEM_FIELDS.has(original)) { used.add(`items[].${original}`); return; }
    if (TOP_LEVEL_FIELDS.has(original)) { used.add(original); return; }
    if (original === "items") return;
    issues.push({ level: "error", message: `Unknown placeholder {{${p.original}}}.${inItems ? " Inside {{#each items}} use description, qty, rate, tax_rate, amount or no; use ../ for other fields." : ""}` });
  };
  visit(ast, false);

  for (const r of REQUIRED_FIELDS) if (!used.has(r)) issues.push({ level: "error", message: `Required field {{${r}}} is missing.` });

  // Images: data: URIs, asset:NAME that exists, or the logo / QR placeholders. Anything else will not load.
  const names = new Set(opts.assetNames ?? []);
  for (const m of code.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]*)/gi)) {
    const src = m[1];
    const field = src.match(/^\{\{\s*([\w.]+)\s*\}\}$/)?.[1];
    if (field && IMAGE_FIELDS.has(field)) continue;
    if (src.startsWith("data:image/")) continue;
    if (src.startsWith("asset:")) { if (!names.has(src.slice(6))) issues.push({ level: "error", message: `Image "${src}" is not uploaded. Upload it under Assets first.` }); continue; }
    issues.push({ level: "error", message: `Image "${src.slice(0, 80)}" cannot load: use {{business.logo}}, {{payment.qr}} or an uploaded asset (asset:logo.png).` });
  }
  if (/<script\b|\son\w+\s*=|javascript:/i.test(code)) issues.push({ level: "warning", message: "Scripts, event handlers (onclick=, onerror=) and javascript: links are removed when the template is saved." });

  return { ok: !issues.some((i) => i.level === "error"), issues, fields: [...used].sort() };
}

/** Fills the template with data and sanitises the result again. Throws on a broken template (the caller falls back). */
export function renderTemplateHtml(source: string, data: ViewData, assets: Record<string, string> = {}): string {
  const template = hb.compile(source, COMPILE_OPTS);
  const html = template(JSON.parse(JSON.stringify(data)), { allowProtoPropertiesByDefault: false, allowProtoMethodsByDefault: false });
  // asset:NAME -> data: URI of the user's own uploaded file (the only "network" a template can reach).
  const withAssets = html.replace(/asset:([A-Za-z0-9._-]{1,80})/g, (m, name) => assets[name] ?? m);
  return sanitizeTemplateHtml(withAssets);
}
