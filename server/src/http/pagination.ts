import { z } from "zod";
import { ValidationError } from "../errors.js";

/** `?limit=` (1-100, default 25). */
export const limitSchema = z.coerce.number().int().min(1).max(100).default(25);

/**
 * Keyset ("seek") pagination cursor: the sort key of the last row seen, opaque to clients.
 * Stable under inserts and fast on any page depth, unlike OFFSET.
 */
export interface Cursor {
  /** ISO timestamp of the last row's sort column. */
  t: string;
  /** Id of the last row (tie-breaker). */
  id: string;
}

/**
 * SQL expression that renders a timestamp column at FULL microsecond precision. JavaScript Dates only
 * keep milliseconds, so a cursor built from a Date could skip or repeat rows that differ in the last
 * three digits. Always select the sort column through this and pass the string back as the cursor.
 */
export const cursorTs = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

const cursorSchema = z.object({ t: z.string().datetime({ offset: true }), id: z.string().uuid() });

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw new ValidationError("Invalid cursor", undefined, "INVALID_CURSOR");
  }
}
