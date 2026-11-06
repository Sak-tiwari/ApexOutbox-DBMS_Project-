import type { RawLead, SearchFilters } from "./types";

const WINDOW_MS = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const;
const ENTRY = /\b(junior|entry[- ]level|beginner|intern|trainee)\b/i;
const SENIOR = /\b(senior|sr\.?|lead|principal|expert|staff)\b/i;

/** Filters that sources cannot apply themselves. A post whose date/budget/location is unknown is kept (we would rather show it than hide it). */
export function matchesFilters(lead: RawLead, f: SearchFilters, now = Date.now()): boolean {
  if (f.postedWithin && lead.postedAt && now - lead.postedAt.getTime() > WINDOW_MS[f.postedWithin]) return false;

  const hasBudget = lead.budgetMin !== undefined || lead.budgetMax !== undefined;
  if (hasBudget) {
    const lo = lead.budgetMin ?? lead.budgetMax!;
    const hi = lead.budgetMax ?? lead.budgetMin!;
    if (f.budgetMin !== undefined && hi < f.budgetMin) return false;
    if (f.budgetMax !== undefined && lo > f.budgetMax) return false;
  }

  if (f.remoteOnly && lead.remote === false) return false;
  if (f.location) {
    const loc = (lead.location ?? "").toLowerCase();
    if (loc && !loc.includes(f.location.toLowerCase()) && !(lead.remote && /remote|anywhere|worldwide/.test(loc))) return false;
  }

  if (f.level) {
    const text = `${lead.title} ${lead.description ?? ""}`.slice(0, 1500);
    const isEntry = ENTRY.test(text);
    const isSenior = SENIOR.test(text);
    if (f.level === "entry" && isSenior) return false;
    if (f.level === "senior" && isEntry) return false;
    if (f.level === "mid" && (isEntry || isSenior)) return false;
  }
  return true;
}
