import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Badge, Empty, ErrorState, ListSkeleton, errorText, useToast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago } from "../lib/format";
import { useCursorList, useGet } from "../lib/hooks";
import type { Domain, ScrapeJob } from "../lib/types";

const TONE = { QUEUED: "slate", RUNNING: "blue", SUCCEEDED: "green", FAILED: "red", CANCELLED: "amber" } as const;

export default function Scraper() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const domains = useGet<{ items: Domain[] }>(["scrape-jobs", "domains"], "/scrape/domains");
  const jobs = useCursorList<ScrapeJob>("scrape-jobs", "/scrape/jobs", {});
  const refresh = () => void qc.invalidateQueries({ queryKey: ["scrape-jobs"] });

  const start = useMutation({
    mutationFn: (urls: string[]) => api<ScrapeJob>("/scrape/jobs", { method: "POST", body: { urls, idempotencyKey: crypto.randomUUID() } }),
    onSuccess: () => { toast("Scrape started"); setError(null); refresh(); },
    onError: (e) => setError(errorText(e)),
  });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/scrape/jobs/${id}/cancel`, { method: "POST" }), onSuccess: refresh, onError: (e) => toast(errorText(e), "error") });
  const addDomain = useMutation({
    mutationFn: (domain: string) => api("/scrape/domains", { method: "POST", body: { domain } }),
    onSuccess: refresh, onError: (e) => toast(errorText(e), "error"),
  });
  const delDomain = useMutation({ mutationFn: (id: string) => api(`/scrape/domains/${id}`, { method: "DELETE" }), onSuccess: refresh, onError: (e) => toast(errorText(e), "error") });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const urls = String(new FormData(e.currentTarget).get("urls")).split(/\s+/).map((u) => u.trim()).filter(Boolean);
    if (!urls.length) return setError("Enter at least one URL.");
    start.mutate(urls);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Lead scraper</h1>
      <section className="card" aria-labelledby="new">
        <h2 id="new" className="mb-2 font-semibold">New job</h2>
        <p className="mb-3 text-sm text-slate-700 dark:text-slate-300">Only pages on approved domains are fetched, politely, and robots.txt is respected. Up to 20 URLs.</p>
        <form onSubmit={submit} className="space-y-3">
          {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
          <textarea name="urls" className="input py-2" rows={3} aria-label="URLs, one per line" placeholder="https://example.com/contact" inputMode="url" autoCapitalize="none" spellCheck={false} />
          <button className="btn-primary" disabled={start.isPending}>{start.isPending ? "Starting…" : "Start scrape"}</button>
        </form>
      </section>

      <section className="card" aria-labelledby="dom">
        <h2 id="dom" className="mb-2 font-semibold">Approved domains</h2>
        {domains.isPending ? <ListSkeleton rows={2} /> : domains.isError ? <ErrorState error={domains.error} onRetry={() => void domains.refetch()} /> : (
          <>
            {domains.data.items.length === 0 && <p className="text-sm">None yet. {can("scrape:manage_domains") ? "Add one below." : "Ask an admin to approve a domain."}</p>}
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {domains.data.items.map((d) => (
                <li key={d.id} className="flex items-center justify-between py-1.5 text-sm">{d.domain}
                  {can("scrape:manage_domains") && <button className="btn-secondary" onClick={() => delDomain.mutate(d.id)} aria-label={`Remove ${d.domain}`}>Remove</button>}
                </li>
              ))}
            </ul>
            {can("scrape:manage_domains") && (
              <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget; const v = String(new FormData(f).get("domain")).trim(); if (v) { addDomain.mutate(v); f.reset(); } }}>
                <input name="domain" className="input" aria-label="Domain" placeholder="example.com" inputMode="url" autoCapitalize="none" spellCheck={false} />
                <button className="btn-secondary">Add</button>
              </form>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="hist">
        <h2 id="hist" className="mb-2 font-semibold">Jobs</h2>
        {jobs.isPending ? <ListSkeleton rows={3} /> : jobs.isError ? <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} /> :
          jobs.items.length === 0 ? <Empty title="No jobs yet" hint="Start one above. Progress shows here live." /> : (
            <ul className="space-y-3">
              {jobs.items.map((j) => {
                const active = j.status === "QUEUED" || j.status === "RUNNING";
                const pct = j.pagesTotal ? Math.round((j.pagesDone / j.pagesTotal) * 100) : 0;
                return (
                  <li key={j.id} className="card space-y-2">
                    <div className="flex items-center justify-between gap-2"><Badge tone={TONE[j.status]}>{j.status}</Badge><span className="text-xs">{ago(j.createdAt)}</span></div>
                    <p className="truncate text-sm">{j.urls.join(", ")}</p>
                    <div className="h-2 rounded bg-slate-200 dark:bg-slate-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Pages scraped"><div className="h-2 rounded bg-brand-600 transition-all" style={{ width: `${pct}%` }} /></div>
                    <p className="text-sm tabular-nums">{j.pagesDone}/{j.pagesTotal} pages · {j.inserted} new · {j.duplicates} duplicates · {j.rejected} rejected</p>
                    {j.errors.slice(0, 3).map((er, i) => <p key={i} className="truncate text-xs text-red-700 dark:text-red-300">{er.url}: {er.message}</p>)}
                    {active && <button className="btn-secondary" onClick={() => cancel.mutate(j.id)}>Cancel</button>}
                  </li>
                );
              })}
            </ul>
          )}
        <div ref={jobs.sentinel} />
        {jobs.hasNextPage && <div className="mt-3 flex justify-center"><button className="btn-secondary" onClick={() => void jobs.fetchNextPage()}>Load more</button></div>}
      </section>
    </div>
  );
}
