import { z } from "zod";

// Free text: control characters become spaces, then trimmed and length-capped. Output escaping is the UI's job.
// eslint-disable-next-line no-control-regex
export const clean = (max: number) => z.string().transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim()).pipe(z.string().min(1).max(max));
export const optionalText = (max: number) => z.union([clean(max), z.literal("").transform(() => null), z.null()]);

export const email = z.string().trim().toLowerCase().email().max(254);
/** Starts with + or a digit and then only digits and common separators, so it can never read as a spreadsheet formula ("+1+1", "=cmd"). */
export const phone = z.string().trim().regex(/^\+?[0-9][0-9 ().\-]{4,39}$/, "Digits, spaces and + ( ) - only");
/** Only http(s) URLs are accepted, so a lead's website can never be a javascript: or data: link. */
export const website = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
      return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && u.hostname.includes(".");
    } catch {
      return false;
    }
  }, "Must be a valid http(s) website");
export const nullable = <T extends z.ZodType>(s: T) => z.union([s, z.literal("").transform(() => null), z.null()]);

/** Leading characters spreadsheets treat as the start of a formula. */
export const FORMULA_START = /^[=+\-@\t\r]/;
