import { load } from "cheerio";
import type { LeadSource, RawLead } from "../types";

/** We Work Remotely RSS feeds (programming and design categories). */
export function weWorkRemotelySource(opts: { baseUrl?: string; feeds?: string[] } = {}): LeadSource {
  const base = opts.baseUrl ?? "https://weworkremotely.com";
  const feeds = opts.feeds ?? ["/categories/remote-full-stack-programming-jobs.rss", "/categories/remote-front-end-programming-jobs.rss", "/categories/remote-design-jobs.rss", "/remote-jobs.rss"];
  return {
    id: "weworkremotely",
    name: "We Work Remotely",
    async search(_query, ctx) {
      const out: RawLead[] = [];
      const seen = new Set<string>();
      let ok = 0;
      let lastError: unknown;
      for (const f of feeds) {
        try {
          const $ = load(await ctx.get(`${base}${f}`), { xmlMode: true });
          ok++;
          $("item").each((_, el) => {
            const link = $(el).find("link").first().text().trim() || $(el).find("guid").first().text().trim();
            const rawTitle = $(el).find("title").first().text().trim();
            if (!link || !rawTitle || seen.has(link)) return;
            seen.add(link);
            const [company, ...rest] = rawTitle.includes(":") ? rawTitle.split(":") : ["", rawTitle];
            const pub = $(el).find("pubDate").first().text().trim();
            out.push({
              externalId: link,
              title: (rest.join(":") || rawTitle).trim(),
              url: link,
              company: company.trim() || undefined,
              description: load($(el).find("description").first().text())("body").text().replace(/\s+/g, " ").slice(0, 1500),
              location: $(el).find("region").first().text().trim() || "Remote", remote: true,
              postedAt: pub ? new Date(pub) : undefined,
            });
          });
        } catch (error) {
          lastError = error;
        }
      }
      if (ok === 0 && lastError) throw lastError;
      return out;
    },
  };
}
