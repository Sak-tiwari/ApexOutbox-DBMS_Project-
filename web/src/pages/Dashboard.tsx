import { Link } from "react-router-dom";
import { Empty, ErrorState, Skeleton } from "../components/ui";
import { useAuth } from "../lib/auth";
import { money } from "../lib/format";
import { useGet } from "../lib/hooks";
import { LEAD_STATUSES, STATUS_LABEL, type EmailStats, type InvoiceStats, type LeadStats } from "../lib/types";

const Tile = ({ label, value, to, tone }: { label: string; value: string | number; to?: string; tone?: "warn" }) => {
  const body = (
    <div className={`card h-full ${tone === "warn" ? "border-amber-400" : ""}`}>
      <p className="text-sm text-slate-700 dark:text-slate-300">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
  return to ? <Link to={to} className="block">{body}</Link> : body;
};

export default function Dashboard() {
  const { can, me } = useAuth();
  const leads = useGet<LeadStats>(["lead-stats"], "/leads/stats", can("leads:read"));
  const inv = useGet<InvoiceStats>(["invoice-stats"], "/invoices/stats", can("invoices:read"));
  const mail = useGet<EmailStats>(["email-stats"], "/emails/stats", can("invoices:read"));
  const max = Math.max(1, ...Object.values(leads.data?.byStatus ?? {}));
  const months = inv.data?.monthly ?? [];
  const mmax = Math.max(1, ...months.map((m) => m.billedMinor));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Hello, {me?.user.name.split(" ")[0]}</h1>
      {leads.isError && <ErrorState error={leads.error} onRetry={() => void leads.refetch()} />}
      <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {leads.isPending && can("leads:read") ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20" />) : (
          <>
            {leads.data && <Tile label="Total leads" value={leads.data.total} to="/leads" />}
            {leads.data && <Tile label="Needs review" value={leads.data.needsReview} to="/leads" tone={leads.data.needsReview ? "warn" : undefined} />}
            {leads.data && <Tile label="Follow-ups due" value={leads.data.followUpDue} tone={leads.data.followUpDue ? "warn" : undefined} />}
            {leads.data && <Tile label="Won" value={leads.data.byStatus.CLOSED_WON} />}
            {inv.data && <Tile label="Outstanding" value={money(inv.data.outstandingMinor)} to="/invoices" />}
            {inv.data && <Tile label="Paid" value={money(inv.data.paidMinor)} />}
            {inv.data && <Tile label="Overdue" value={inv.data.overdue.count} to="/invoices" tone={inv.data.overdue.count ? "warn" : undefined} />}
            {mail.data && <Tile label="E-mails needing attention" value={mail.data.needsAttention} to="/invoices" tone={mail.data.needsAttention ? "warn" : undefined} />}
          </>
        )}
      </section>

      {leads.data && (
        <section className="card" aria-labelledby="pipe">
          <h2 id="pipe" className="mb-3 font-semibold">Pipeline</h2>
          {leads.data.total === 0 ? <Empty title="No leads yet" hint="Add or scrape some leads to see your pipeline." /> : (
            <ul className="space-y-2">
              {LEAD_STATUSES.map((s) => (
                <li key={s} className="flex items-center gap-3 text-sm">
                  <span className="w-24 flex-none">{STATUS_LABEL[s]}</span>
                  <div className="h-5 flex-1 rounded bg-slate-100 dark:bg-slate-800" role="img" aria-label={`${STATUS_LABEL[s]}: ${leads.data.byStatus[s]}`}>
                    <div className="h-5 rounded bg-brand-600" style={{ width: `${(leads.data.byStatus[s] / max) * 100}%` }} />
                  </div>
                  <span className="w-8 flex-none text-right tabular-nums">{leads.data.byStatus[s]}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {inv.data && (
        <section className="card" aria-labelledby="rev">
          <h2 id="rev" className="mb-3 font-semibold">Billed vs paid, last 6 months</h2>
          <div className="flex h-40 items-end gap-2" role="img" aria-label={months.map((m) => `${m.month}: billed ${money(m.billedMinor)}, paid ${money(m.paidMinor)}`).join("; ")}>
            {months.map((m) => (
              <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex h-32 w-full items-end justify-center gap-1">
                  <div className="w-1/2 rounded-t bg-brand-600" style={{ height: `${(m.billedMinor / mmax) * 100}%`, minHeight: m.billedMinor ? 2 : 0 }} />
                  <div className="w-1/2 rounded-t bg-emerald-600" style={{ height: `${(m.paidMinor / mmax) * 100}%`, minHeight: m.paidMinor ? 2 : 0 }} />
                </div>
                <span className="text-xs text-slate-700 dark:text-slate-300">{m.month.slice(5)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 flex gap-4 text-xs"><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-brand-600" />Billed</span><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-600" />Paid</span></p>
        </section>
      )}
    </div>
  );
}
