import type { RawLead } from "./types";

const DAY = 86_400_000;

function countsIn(text: string, keyword: string): boolean {
  if (!keyword) return false;
  // Whole-word match for single words ("art" must not match "start"); phrases match as typed.
  const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`, "i").test(text);
}

/**
 * Match score 0-100 of one post against the user's keywords.
 *   up to 70  keyword coverage: a keyword in the title counts fully, in the description half.
 *             The denominator is min(number of keywords, 4), so a few strong hits already score well.
 *   up to 20  a keyword that is the whole phrase of the title/description ("web developer") earns extra
 *   up to 10  freshness: 10 for today, falling to 0 at 30 days
 * A post with no keyword hit scores 0.
 */
export function scoreLead(lead: Pick<RawLead, "title" | "description" | "postedAt">, keywords: string[], now = Date.now()): number {
  const kws = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  if (kws.length === 0) return 0;
  const title = lead.title.toLowerCase();
  const desc = (lead.description ?? "").toLowerCase().slice(0, 4000);

  let raw = 0;
  let phraseBonus = 0;
  for (const k of kws) {
    if (countsIn(title, k)) { raw += 1; if (k.includes(" ")) phraseBonus = 1; }
    else if (countsIn(desc, k)) { raw += 0.5; if (k.includes(" ") && phraseBonus === 0) phraseBonus = 0.5; }
  }
  if (raw === 0) return 0;

  const coverage = Math.min(1, raw / Math.min(kws.length, 4));
  let fresh = 5; // unknown date: neutral
  if (lead.postedAt) {
    const ageDays = Math.max(0, (now - lead.postedAt.getTime()) / DAY);
    fresh = Math.max(0, 10 * (1 - ageDays / 30));
  }
  return Math.max(1, Math.min(100, Math.round(coverage * 70 + phraseBonus * 20 + fresh)));
}
