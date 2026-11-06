import type { LeadSource, RawLead } from "../types";

/** RemoteOK public JSON API (they ask for a link back to the original post, which every result carries). */
export function remoteOkSource(opts: { baseUrl?: string } = {}): LeadSource {
  const base = opts.baseUrl ?? "https://remoteok.com";
  return {
    id: "remoteok",
    name: "RemoteOK",
    async search(_query, ctx) {
      const rows = JSON.parse(await ctx.get(`${base}/api`)) as Array<Record<string, any>>;
      const out: RawLead[] = [];
      for (const r of rows) {
        if (!r || !r.id || !r.position) continue; // first element is a legal notice
        const sal = r.salary_min && r.salary_max ? `$${Number(r.salary_min).toLocaleString("en-US")}–$${Number(r.salary_max).toLocaleString("en-US")}/yr` : undefined;
        out.push({
          externalId: String(r.id),
          title: String(r.position),
          url: String(r.url ?? r.apply_url ?? `${base}/remote-jobs/${r.id}`),
          company: r.company ? String(r.company) : undefined,
          description: String(r.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1500) + (Array.isArray(r.tags) ? ` ${r.tags.join(" ")}` : ""),
          budgetText: sal, budgetMin: r.salary_min ? Number(r.salary_min) || undefined : undefined, budgetMax: r.salary_max ? Number(r.salary_max) || undefined : undefined,
          location: r.location ? String(r.location) : "Remote", remote: true,
          postedAt: r.date ? new Date(r.date) : undefined,
        });
      }
      return out;
    },
  };
}
