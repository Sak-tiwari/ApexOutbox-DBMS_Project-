/**
 * Turns "We build websites for small businesses: React, WordPress, Shopify" into search keywords.
 * No LLM: stop-word removal plus a synonym map of common freelance services. The user can edit the result.
 */

const STOP = new Set(("a an and are as at be by for from get has have i in is it its of on or our we us you your the to with " +
  "that this these those can will do does make made build builds building offer offers provide provides specialize specializes " +
  "specialise specialises specialized company agency studio team services service business businesses small medium clients client " +
  "help helps work works working based also more very all any").split(/\s+/));

const SYNONYMS: Array<[RegExp, string[]]> = [
  [/\b(web ?sites?|web ?design|web ?dev\w*|landing ?pages?|front ?end)\b/, ["website", "web developer", "web design", "landing page", "wordpress", "shopify", "react"]],
  [/\b(wordpress|woocommerce)\b/, ["wordpress", "woocommerce", "website"]],
  [/\b(shopify|e-?commerce|online store)\b/, ["shopify", "ecommerce", "online store"]],
  [/\b(react|next\.?js|node\.?js|javascript|typescript|full ?stack)\b/, ["react", "javascript", "full stack developer"]],
  [/\b(mobile|android|ios|flutter|react native|apps?)\b/, ["mobile app", "android", "ios", "flutter", "app developer"]],
  [/\b(logos?|brand\w*|graphic\w*|design\w*|ui|ux|figma)\b/, ["logo design", "branding", "graphic design", "ui ux", "figma"]],
  [/\b(seo|search engine|marketing|ads|social media|instagram|content)\b/, ["seo", "digital marketing", "social media", "content writing"]],
  [/\b(videos?|editing|animation|reels?)\b/, ["video editing", "animation", "motion graphics"]],
  [/\b(writ\w*|copy\w*|blog\w*|articles?|translation)\b/, ["content writer", "copywriting", "blog writing"]],
  [/\b(data|python|scrap\w*|automation|bots?|ai|machine learning)\b/, ["python", "data scraping", "automation", "chatbot", "data analysis"]],
  [/\b(crm|dashboard|saas|software|backend|api)\b/, ["backend developer", "api", "saas", "dashboard", "software developer"]],
];

export const MAX_KEYWORDS = 15;

export function normaliseKeyword(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9+#.\s-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

export function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase().slice(0, 2000);
  const out: string[] = [];
  const add = (k: string) => {
    const n = normaliseKeyword(k);
    if (n.length >= 2 && !STOP.has(n) && !out.includes(n)) out.push(n);
  };
  for (const [re, words] of SYNONYMS) if (re.test(lower)) words.forEach(add);
  // Words the user wrote themselves (technologies, niches) come right after the mapped ones.
  for (const w of lower.split(/[^a-z0-9+#.]+/)) if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) add(w);
  return out.slice(0, MAX_KEYWORDS);
}

/** A manual query like "react developer" plus any extra keywords the user ticked. */
export function keywordsFromQuery(query: string): string[] {
  const out: string[] = [];
  const q = normaliseKeyword(query);
  if (q) out.push(q);
  for (const k of extractKeywords(query)) if (!out.includes(k)) out.push(k);
  return out.slice(0, MAX_KEYWORDS);
}

export function cleanKeywordList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const k of list) {
    const n = typeof k === "string" ? normaliseKeyword(k) : "";
    if (n && !out.includes(n)) out.push(n);
  }
  return out.slice(0, MAX_KEYWORDS);
}
