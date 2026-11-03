import argon2 from "argon2";
import { randomInt } from "node:crypto";

/** OWASP-recommended Argon2id parameters (19 MiB, 2 passes, 1 lane). */
const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** True when the stored hash uses weaker parameters than today's: re-hash on the next successful login. */
export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, ARGON_OPTIONS);
}

let dummyHash: Promise<string> | undefined;
/**
 * Verified against when the e-mail address is unknown, so "no such user" costs the same time as
 * "wrong password" and response timing cannot be used to discover which e-mail addresses have accounts.
 */
export function verifyAgainstDummy(password: string): Promise<boolean> {
  dummyHash ??= hashPassword("dummy-password-for-timing-equalisation");
  return dummyHash.then((h) => verifyPassword(h, password));
}

// ---------------------------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------------------------

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export const PASSWORD_POLICY_TEXT =
  `At least ${PASSWORD_MIN} characters. Use 3 of: lower-case, upper-case, digit, symbol (or make it 20+ characters long). ` +
  `No common passwords, no part of your name or e-mail, no run of 4 identical characters.`;

// Frequently breached passwords. Not exhaustive (a breached-password API would be better in production),
// but it blocks the worst offenders, including their common "12+ character" variants.
const COMMON = new Set([
  "password", "password1", "password12", "password123", "password1234", "passw0rd", "p@ssw0rd", "p@ssword",
  "123456789012", "1234567890123", "123456789", "12345678", "qwertyuiop", "qwertyuiop123", "qwerty123456",
  "qwertyuiopasdf", "asdfghjkl123", "iloveyou1234", "letmein12345", "welcome12345", "administrator",
  "admin123456", "admin@123456", "changeme1234", "changemenow", "abcdefghijkl", "abcd1234abcd", "1q2w3e4r5t6y",
  "1qaz2wsx3edc", "zaq12wsxcde3", "monkey123456", "dragon123456", "football1234", "baseball1234", "sunshine1234",
  "princess1234", "trustno1trustno1", "superman1234", "whatever1234", "internet1234", "computer1234",
  "india@123456", "india123456", "welcome@12345", "apexoutbox", "apexoutbox123", "apexoutbox1234",
]);

// Bases that stay weak however they are decorated ("Welcome@12345", "p@ssw0rd!!", "Qwerty-2024").
const WEAK_BASES = new Set([
  "password", "passwd", "passw", "qwerty", "qwertyuiop", "qwertyuiopasdf", "asdfghjkl", "letmein", "welcome", "iloveyou",
  "admin", "administrator", "changeme", "monkey", "dragon", "football", "baseball", "sunshine", "princess", "trustno",
  "superman", "whatever", "internet", "computer", "india", "apexoutbox", "abcdefghijkl", "master", "login", "secret",
]);

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s", "!": "i" };

/** Strips leading/trailing digits and symbols, then undoes common character swaps (0->o, @->a, ...). */
function weakBaseOf(lower: string): string[] {
  const core = lower.replace(/^[^a-z]+|[^a-z]+$/g, "");
  const swapped = (oneAs: string) =>
    [...core].map((ch) => (ch === "1" ? oneAs : (LEET[ch] ?? ch))).join("").replace(/[^a-z]/g, "");
  return [swapped("i"), swapped("l")];
}

function classesOf(p: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
}

export interface PasswordContext {
  email?: string;
  name?: string;
}

/** Returns a list of human-readable problems. Empty list = acceptable. */
export function checkPasswordPolicy(password: string, ctx: PasswordContext = {}): string[] {
  const problems: string[] = [];
  const length = [...password].length;
  if (length < PASSWORD_MIN) problems.push(`Must be at least ${PASSWORD_MIN} characters long.`);
  if (length > PASSWORD_MAX) problems.push(`Must be at most ${PASSWORD_MAX} characters long.`);
  if (length >= PASSWORD_MIN && length < 20 && classesOf(password) < 3) {
    problems.push("Use at least 3 of: lower-case, upper-case, digit, symbol (or make it 20+ characters long).");
  }
  const lower = password.toLowerCase();
  const squashed = lower.replace(/[^a-z0-9]/g, "");
  if (COMMON.has(lower) || COMMON.has(squashed) || weakBaseOf(lower).some((b) => WEAK_BASES.has(b))) {
    problems.push("This password is too common.");
  }
  if (/(.)\1{3,}/.test(password)) problems.push("Must not contain 4 or more identical characters in a row.");

  const personal: string[] = [];
  const local = ctx.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4) personal.push(local);
  for (const part of (ctx.name ?? "").toLowerCase().split(/\s+/)) if (part.length >= 4) personal.push(part);
  if (personal.some((p) => squashed.includes(p.replace(/[^a-z0-9]/g, "")))) {
    problems.push("Must not contain your name or e-mail address.");
  }
  return problems;
}

const TEMP_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TEMP_SYMBOLS = "!@#$%^&*-_=+";

/** A random temporary password (admin-created accounts, resets). Always passes the policy. */
export function generateTemporaryPassword(): string {
  const pick = (set: string) => set[randomInt(set.length)]!;
  while (true) {
    const chars = Array.from({ length: 16 }, () => pick(TEMP_ALPHABET));
    chars[randomInt(16)] = pick(TEMP_SYMBOLS);
    chars[randomInt(16)] = pick("23456789");
    chars[randomInt(16)] = pick("ABCDEFGHJKLMNPQRSTUVWXYZ");
    const candidate = chars.join("");
    if (checkPasswordPolicy(candidate).length === 0) return candidate;
  }
}
