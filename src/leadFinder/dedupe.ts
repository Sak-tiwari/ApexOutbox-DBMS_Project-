/**
 * The same request is often posted on several platforms (or twice on one). The fuzzy key is the
 * company and the title with punctuation, case, tags such as [HIRING] and filler words removed.
 */
const FILLER = new Set(["a", "an", "the", "for", "to", "of", "and", "or", "in", "my", "our", "need", "needed", "looking", "wanted", "hiring", "hire", "seeking", "required", "urgent"]);

export function normaliseText(s: string): string {
  return s.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function fuzzyKey(company: string | undefined, title: string): string {
  const words = normaliseText(title).split(" ").filter((w) => w && !FILLER.has(w));
  const company_ = normaliseText(company ?? "");
  return `${company_}|${[...new Set(words)].sort().join(" ")}`.slice(0, 300);
}
