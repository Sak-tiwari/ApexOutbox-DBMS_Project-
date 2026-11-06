import JSZip from "jszip";
import mammoth from "mammoth";
import { TemplateError } from "./store";

/** What [[ITEMS_TABLE]] in a Word file becomes: a line-items table with the {{#each items}} loop. */
const ITEMS_TABLE = `<table class="items"><thead><tr><th>#</th><th>Description</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">GST</th><th class="n">Amount</th></tr></thead>
<tbody>{{#each items}}<tr><td>{{no}}</td><td>{{description}}</td><td class="n">{{qty}}</td><td class="n">{{rate}}</td><td class="n">{{tax_rate}}</td><td class="n">{{amount}}</td></tr>{{/each}}</tbody></table>`;

const PAGE_CSS = `@page { size: A4; margin: 16mm; } body { font-family: Helvetica, Arial, sans-serif; font-size: 12px; color: #1b1f33; }
table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #d5d8e3; padding: 6px 8px; vertical-align: top; } th { background: #f2f3f8; text-align: left; }
.n { text-align: right; white-space: nowrap; } img { max-width: 100%; }`;

/**
 * Word (.docx) -> template HTML. Placeholders are typed in Word exactly like in HTML ({{client.name}}).
 * Line items: type [[ITEMS_TABLE]] on its own line. Macro-enabled files (.docm, vbaProject.bin) are refused.
 * Layout is simplified: text, headings, bold/italic, lists, tables and images come through; exact Word
 * positioning does not.
 */
export async function docxToTemplateHtml(buf: Buffer): Promise<{ html: string; warnings: string[] }> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buf); } catch { throw new TemplateError("That is not a valid .docx file"); }
  const types = (await zip.file("[Content_Types].xml")?.async("string")) ?? "";
  if (zip.file(/vbaProject\.bin$/i).length > 0 || /macroEnabled/i.test(types)) throw new TemplateError("Macro-enabled Word files are not accepted. Save it as a normal .docx (without macros) and upload again.", 415);
  if (!zip.file("word/document.xml")) throw new TemplateError("That .docx file has no document inside");
  if (zip.file(/\.(exe|dll|js|vbs|bat|cmd|ps1)$/i).length > 0) throw new TemplateError("That .docx contains embedded program files and was refused", 415);

  const result = await mammoth.convertToHtml({ buffer: buf }, { includeDefaultStyleMap: true });
  let body = result.value
    // Word often splits "{{client.name}}" with formatting tags; join braces back together.
    .replace(/\{(<[^>]+>)*\{/g, "{{").replace(/\}(<[^>]+>)*\}/g, "}}")
    .replace(/<p>\s*\[\[ITEMS_TABLE\]\]\s*<\/p>/gi, ITEMS_TABLE)
    .replace(/\[\[ITEMS_TABLE\]\]/gi, ITEMS_TABLE);
  // Placeholders inside a {{...}} must not contain tags (e.g. bold in the middle).
  body = body.replace(/\{\{([^}]*)\}\}/g, (_m, inner) => `{{${inner.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim()}}}`);
  return {
    html: `<!doctype html><html><head><meta charset="utf-8"><title>Invoice {{invoice.number}}</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`,
    warnings: result.messages.filter((m) => m.type === "warning").map((m) => m.message).slice(0, 10),
  };
}
