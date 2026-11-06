import { parseBudget } from "../budget";
import type { LeadSource, RawLead } from "../types";

interface RedditPost {
  data: { id: string; title: string; selftext?: string; author?: string; permalink: string; created_utc: number; link_flair_text?: string };
}

/** Public JSON listing of a subreddit. Only posts that are asking for work are kept. */
export function redditSource(opts: { baseUrl?: string; subreddits?: Array<{ name: string; hiring: RegExp }> } = {}): LeadSource {
  const base = opts.baseUrl ?? "https://www.reddit.com";
  const subs = opts.subreddits ?? [
    { name: "forhire", hiring: /\[hiring\]/i },
    { name: "slavelabour", hiring: /\[task\]/i },
    { name: "DoneDirtCheap", hiring: /\[task\]|\[hiring\]/i },
  ];
  return {
    id: "reddit",
    name: "Reddit (r/forhire and similar)",
    async search(_query, ctx) {
      const out: RawLead[] = [];
      let lastError: unknown;
      let okSubs = 0;
      for (const sub of subs) {
        try {
          const body = JSON.parse(await ctx.get(`${base}/r/${sub.name}/new.json?limit=100&raw_json=1`));
          okSubs++;
          for (const p of (body?.data?.children ?? []) as RedditPost[]) {
            const d = p.data;
            if (!d?.id || !d.title || !sub.hiring.test(d.title)) continue;
            const text = `${d.title}\n${d.selftext ?? ""}`;
            const budget = parseBudget(text.match(/(?:budget|pay|paying|\$)[^\n]{0,40}/i)?.[0]);
            out.push({
              externalId: `${sub.name}:${d.id}`,
              title: d.title.replace(/^\s*\[[^\]]*\]\s*/, "").trim() || d.title,
              url: `https://www.reddit.com${d.permalink}`,
              company: d.author ? `u/${d.author}` : undefined,
              description: (d.selftext ?? "").slice(0, 1500),
              budgetText: budget.min ? `$${budget.min}${budget.max && budget.max !== budget.min ? `–$${budget.max}` : ""}` : undefined,
              budgetMin: budget.min, budgetMax: budget.max,
              remote: true,
              postedAt: new Date(d.created_utc * 1000),
            });
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (okSubs === 0 && lastError) throw lastError; // every subreddit failed: report why
      return out;
    },
  };
}
