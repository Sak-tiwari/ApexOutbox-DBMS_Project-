/**
 * Lead identity normalisation and deduplication key.
 * Two scraped records describing the same business must produce the same key,
 * so the unique index {tenantId, dedupeKey} can reject duplicates at the database level.
 */

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "yahoo.in",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "rediffmail.com",
]);

export function normalizeEmail(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null;
  return v;
}

export function normalizeDomain(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(v)) v = `https://${v}`;
  try {
    const host = new URL(v).hostname.replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/** Keeps digits (and a leading +). Does not guess a country code. */
export function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

export interface IdentityInput {
  website?: string | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * Priority: business website domain > business email > phone.
 * Free-mail domains (gmail etc.) never identify a business, so the full address is used instead.
 * Returns null when there is nothing reliable to dedupe on: such leads go to manual review.
 */
export function buildDedupeKey(input: IdentityInput): string | null {
  const domain = normalizeDomain(input.website);
  if (domain) return `domain:${domain}`;

  const email = normalizeEmail(input.email);
  if (email) {
    const emailDomain = email.split("@")[1] ?? "";
    return FREE_EMAIL_DOMAINS.has(emailDomain) ? `email:${email}` : `domain:${emailDomain}`;
  }

  const phone = normalizePhone(input.phone);
  if (phone) return `phone:${phone}`;

  return null;
}
