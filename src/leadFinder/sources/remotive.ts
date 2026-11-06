import type { LeadSource, RawLead } from "../types";

/** Remotive public API: remote jobs, searchable by keyword. */
export function remotiveSource(opts: { baseUrl?: string } = {}): LeadSource {
  const base = opts.baseUrl ?? "https://remotive.com";
  return {
    id: "remotive",
    name: "Remotive",
    async search(query, ctx) {
      const seen = new Set<string>();
      const out: RawLead[] = [];
      for (const kw of query.keywords.slice(0, 3)) {
        const body = JSON.parse(await ctx.get(`${base}/api/remote-jobs?search=${encodeURIComponent(kw)}&limit=50`));
        for (const j of (body?.jobs ?? []) as Array<Record<string, any>>) {
          const id = String(j.id ?? "");
          if (!id || seen.has(id) || !j.title) continue;
          seen.add(id);
          out.push({
            externalId: id,
            title: String(j.title),
            url: String(j.url),
            company: j.company_name ? String(j.company_name) : undefined,
            description: String(j.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1500),
            budgetText: j.salary ? String(j.salary) : undefined,
            location: j.candidate_required_location ? String(j.candidate_required_location) : "Remote", remote: true,
            postedAt: j.publication_date ? new Date(j.publication_date) : undefined,
          });
        }
      }
      return out;
    },
  };
}
