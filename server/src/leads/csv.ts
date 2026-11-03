import { z } from "zod";
import { buildDedupeKey } from "../domain/normalize.js";
import { clean, email, FORMULA_START, nullable, optionalText, phone, website } from "./validation.js";

export const CSV_MAX_ROWS = 1000;
export const CSV_MAX_COLUMNS = 20;
export const CSV_MAX_CELL = 1000;

export class CsvFormatError extends Error {
  constructor(message: string, public readonly code = "INVALID_CSV") {
    super(message);
  }
}

/** RFC 4180 parser: quoted fields, doubled quotes, embedded commas and newlines, CRLF/LF, optional BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const pushCell = () => {
    if (cell.length > CSV_MAX_CELL) throw new CsvFormatError(`A cell is longer than ${CSV_MAX_CELL} characters`, "CSV_CELL_TOO_LONG");
    row.push(cell);
    cell = "";
    if (row.length > CSV_MAX_COLUMNS) throw new CsvFormatError(`More than ${CSV_MAX_COLUMNS} columns`, "CSV_TOO_WIDE");
  };
  const pushRow = () => {
    pushCell();
    if (!(row.length === 1 && row[0] === "")) rows.push(row); // skip blank lines
    row = [];
    if (rows.length > CSV_MAX_ROWS + 1) throw new CsvFormatError(`More than ${CSV_MAX_ROWS} rows. Split the file.`, "CSV_TOO_MANY_ROWS");
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      if (cell.length > CSV_MAX_CELL * 4) throw new CsvFormatError("A cell is too long", "CSV_CELL_TOO_LONG");
      i++;
      continue;
    }
    if (ch === '"' && cell === "") { inQuotes = true; i++; continue; }
    if (ch === ",") { pushCell(); i++; continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      pushRow();
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (inQuotes) throw new CsvFormatError("A quoted cell is never closed");
  if (cell !== "" || row.length > 0) pushRow();
  return rows;
}

const ALIASES: Record<string, string[]> = {
  name: ["name", "full name", "contact", "contact name"],
  companyName: ["company", "company name", "business", "business name", "organization", "organisation"],
  email: ["email", "e-mail", "email address", "mail"],
  phone: ["phone", "mobile", "telephone", "tel", "phone number", "contact number"],
  website: ["website", "url", "site", "web", "web site", "domain"],
};
type Field = keyof typeof ALIASES;

export interface ImportRow {
  name: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  dedupeKey: string | null;
}
export interface RowError { row: number; message: string }

const rowSchema = z.object({
  name: clean(200),
  companyName: optionalText(200).optional(),
  email: nullable(email).optional(),
  phone: nullable(phone).optional(),
  website: nullable(website).optional(),
});

/** Maps header names to fields (case/space-insensitive). Throws when no name or company column exists. */
export function mapHeader(header: string[]): Map<number, Field> {
  const map = new Map<number, Field>();
  const used = new Set<Field>();
  header.forEach((raw, index) => {
    const h = raw.trim().toLowerCase().replace(/[_\s]+/g, " ");
    for (const [field, names] of Object.entries(ALIASES) as [Field, string[]][]) {
      if (names.includes(h) && !used.has(field)) { map.set(index, field); used.add(field); break; }
    }
  });
  if (!used.has("name") && !used.has("companyName")) throw new CsvFormatError("The first row must name its columns, with at least a 'name' or 'company' column", "CSV_NO_NAME_COLUMN");
  return map;
}

/**
 * Validates every data row independently. A bad row is reported (with its line number) and skipped; it never
 * fails the whole file. Cells that start like a spreadsheet formula (= + - @ tab CR) are refused so a CSV can
 * never plant a formula that runs when someone later opens an export in Excel or Sheets.
 */
export function validateRows(table: string[][]): { rows: { line: number; data: ImportRow }[]; errors: RowError[]; total: number } {
  if (table.length === 0) throw new CsvFormatError("The file is empty");
  const header = mapHeader(table[0]!);
  const rows: { line: number; data: ImportRow }[] = [];
  const errors: RowError[] = [];
  for (let r = 1; r < table.length; r++) {
    const line = r + 1;
    const cells = table[r]!;
    const input: Partial<Record<Field, string>> = {};
    let formula = false;
    header.forEach((field, col) => {
      const raw = cells[col] ?? "";
      const value = raw.trim();
      // Phone numbers legitimately start with "+"; the phone validator below only admits digits and separators.
      if (field !== "phone" && (FORMULA_START.test(raw) || (value && FORMULA_START.test(value)))) formula = true;
      if (value) input[field] = value;
    });
    if (formula) { errors.push({ row: line, message: "A cell starts with = + - @ and could run as a spreadsheet formula" }); continue; }
    if (!input.name && input.companyName) input.name = input.companyName;
    const parsed = rowSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      errors.push({ row: line, message: `${String(issue.path[0] ?? "row")}: ${issue.message}` });
      continue;
    }
    const d = parsed.data;
    const data: ImportRow = { name: d.name, companyName: d.companyName ?? null, email: d.email ?? null, phone: d.phone ?? null, website: d.website ?? null, dedupeKey: null };
    data.dedupeKey = buildDedupeKey(data);
    rows.push({ line, data });
  }
  return { rows, errors, total: table.length - 1 };
}
