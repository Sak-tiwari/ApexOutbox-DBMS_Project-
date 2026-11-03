import type { ZodType } from "zod";
import { ValidationError } from "../errors.js";

/**
 * Validates untrusted input with a Zod schema and returns the typed, sanitised value.
 * Error details list the field path and a message only: the submitted values are never echoed back
 * (a rejected password must not end up in a response or a log).
 */
export function parse<T>(schema: ZodType<T>, input: unknown, what = "Request"): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      `${what} validation failed`,
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}
