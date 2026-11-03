import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ---- RFC 4648 base32 (no padding), the format authenticator apps expect ----------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---- RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits: what Google Authenticator, Authy, 1Password use) ----

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20)); // 160 bits, as recommended by RFC 4226
}

function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algorithm, key).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin =
    ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secretB32: string, nowMs: number, opts: { digits?: number; algorithm?: "sha1" | "sha256" | "sha512" } = {}): string {
  return hotp(base32Decode(secretB32), totpStep(nowMs), opts.digits, opts.algorithm);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Checks a user-supplied code. Accepts the current step and one step either side (clock drift),
 * and refuses any step <= `lastUsedStep` so a code can never be replayed.
 * Returns the matched step (store it as the new lastUsedStep) or null.
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, lastUsedStep?: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const current = totpStep(nowMs);
  let matched: number | null = null;
  // Check every step in the window without early exit, so timing does not reveal which one matched.
  for (const step of [current - 1, current, current + 1]) {
    if (safeEqual(hotp(key, step), code) && (lastUsedStep == null || step > lastUsedStep)) {
      matched = matched === null ? step : Math.max(matched, step);
    }
  }
  return matched;
}

export function otpauthUri(issuer: string, account: string, secretB32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// ---- encryption of the secret at rest (AES-256-GCM) ------------------------------------------

/** Format: v1.<iv>.<tag>.<ciphertext> (base64url). The key never lives in the database. */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(key: Buffer, stored: string): string {
  const [version, iv, tag, ct] = stored.split(".");
  if (version !== "v1" || !iv || !tag || !ct) throw new Error("unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

// ---- recovery codes ---------------------------------------------------------------------------

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Eight single-use codes like "k3x9a-mq72p". Shown once; only hashes are stored. */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}
