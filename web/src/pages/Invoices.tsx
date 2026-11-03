import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Empty, ErrorState, ListSkeleton, Sheet, errorText, useToast } from "../components/ui";
import { api, downloadPdf } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, dateOnly, money } from "../lib/format";
import { useCursorList, useDebounced, useGet } from "../lib/hooks";
import type { EmailItem, EmailStats, Invoice, InvoiceStatus } from "../lib/types";

const INV_TONE: Record<InvoiceStatus, "slate" | "blue" | "green" | "red" | "amber"> = { DRAFT: "slate", ISSUED: "blue", SENT: "blue", PAID: "green", VOID: "slate" };
const MAIL_TONE = { PENDING: "slate", SENDING: "blue", SENT: "green", FAILED: "red", UNCERTAIN: "amber", ABANDONED: "red" } as const;

export default function Invoices() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"invoices" | "emails">("invoices");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [voiding, setVoiding] = useState<Invoice | null>(null);
  const q = useDebounced(search.trim());
  const invoices = useCursorList<Invoice>("invoices", "/invoices", { q: q || undefined, status: status || undefined });
  const emails = useCursorList<EmailItem>("emails", "/emails", {}, tab === "emails");
  const mailStats = useGet<EmailStats>(["email-stats"], "/emails/stats");
  const manage = can("invoices:manage");
  const done = () => { void qc.invalidateQueries({ queryKey: ["invoices"] }); void qc.invalidateQueries({ queryKey: ["invoice-stats"] }); void qc.invalidateQueries({ queryKey: ["emails"] }); };
  const fail = (e: unknown) => toast(errorText(e), "error");

  const paid = useMutation({ mutationFn: (id: string) => api(`/invoices/${id}/mark-paid`, { method: "POST" }), onSuccess: () => { toast("Marked as paid"); done(); }, onError: fail });
  const resend = useMutation({ mutationFn: (id: string) => api(`/invoices/${id}/resend`, { method: "POST", body: {} }), onSuccess: () => { toast("E-mail queued"); done(); }, onError: fail });
  const retry = useMutation({ mutationFn: (id: string) => api(`/emails/${id}/retry`, { method: "POST" }), onSuccess: done, onError: fail });
  const resolve = useMutation({ mutationFn: (v: { id: string; outcome: "delivered" | "not_delivered" }) => api(`/emails/${v.id}/resolve`, { method: "POST", body: { outcome: v.outcome } }), onSuccess: done, onError: fail });
  const voidIt = useMutation({
    mutationFn: (v: { id: string; reason: string }) => api(`/invoices/${v.id}/void`, { method: "POST", body: { reason: v.reason } }),
    onSuccess: () => { toast("Invoice voided"); setVoiding(null); done(); }, onError: fail,
  });

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Invoices</h1>
      <div className="mb-4 flex border-b border-slate-200 dark:border-slate-800" role="tablist">
        {(["invoices", "emails"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`min-h-tap flex-1 border-b-2 px-4 text-sm font-medium ${tab === t ? "border-brand-600 text-brand-700 dark:text-brand-100" : "border-transparent"}`}>
            {t === "invoices" ? "Invoices" : <>E-mails{mailStats.data?.needsAttention ? <span className="ml-2"><Badge tone="amber">{mailStats.data.needsAttention}</Badge></span> : null}</>}
          </button>
        ))}
      </div>

      {tab === "invoices" ? (
        <>
          <div className="mb-4 flex gap-2">
            <input type="search" className="input" placeholder="Search number or client…" aria-label="Search invoices" value={search} onChange={(e) => setSearch(e.target.value)} inputMode="search" autoComplete="off" />
            <select className="input w-auto" aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>{["ISSUED", "SENT", "PAID", "VOID"].map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()}</option>)}
            </select>
          </div>
          {invoices.isPending ? <ListSkeleton /> : invoices.isError ? <ErrorState error={invoices.error} onRetry={() => void invoices.refetch()} /> :
            invoices.items.length === 0 ? <Empty title="No invoices" hint="An invoice is created when you close a lead as won." /> : (
              <ul className="space-y-3">
                {invoices.items.map((i) => (
                  <li key={i.id} className="card space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0"><p className="font-medium">{i.number ?? "Draft"}</p><p className="truncate text-sm">{i.clientName}</p></div>
                      <div className="flex flex-col items-end gap-1"><Badge tone={INV_TONE[i.status]}>{i.status}</Badge>{i.overdue && <Badge tone="red">Overdue</Badge>}</div>
                    </div>
                    <p className="text-lg font-semibold tabular-nums">{money(i.totalMinor, i.currency)}</p>
                    <p className="text-xs">Issued {dateOnly(i.issuedAt)} · Due {dateOnly(i.dueAt)}</p>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn-secondary" onClick={() => downloadPdf(`/invoices/${i.id}/pdf`, `${i.number ?? "invoice"}.pdf`).catch(fail)}>PDF</button>
                      {manage && (i.status === "ISSUED" || i.status === "SENT") && <>
                        <button className="btn-secondary" disabled={paid.isPending} onClick={() => paid.mutate(i.id)}>Mark paid</button>
                        <button className="btn-secondary" disabled={resend.isPending} onClick={() => resend.mutate(i.id)}>Resend</button>
                        <button className="btn-secondary" onClick={() => setVoiding(i)}>Void</button>
                      </>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          <div ref={invoices.sentinel} />
          {invoices.hasNextPage && <div className="mt-4 flex justify-center"><button className="btn-secondary" onClick={() => void invoices.fetchNextPage()}>Load more</button></div>}
        </>
      ) : (
        <>
          {emails.isPending ? <ListSkeleton /> : emails.isError ? <ErrorState error={emails.error} onRetry={() => void emails.refetch()} /> :
            emails.items.length === 0 ? <Empty title="No e-mails yet" /> : (
              <ul className="space-y-3">
                {emails.items.map((m) => (
                  <li key={m.id} className="card space-y-2">
                    <div className="flex items-start justify-between gap-2"><p className="min-w-0 truncate font-medium">{m.subject}</p><Badge tone={MAIL_TONE[m.status]}>{m.status}</Badge></div>
                    <p className="truncate text-sm">To {m.to} · {ago(m.createdAt)} · attempt {m.attempts}/{m.maxAttempts}</p>
                    {m.lastError && <p className="text-xs text-red-700 dark:text-red-300">{m.lastError}</p>}
                    {m.status === "UNCERTAIN" && <p className="text-sm">We couldn't confirm delivery and will not resend automatically. Check your mail provider, then record what happened.</p>}
                    {manage && (m.status === "FAILED" || m.status === "ABANDONED") && <button className="btn-secondary" onClick={() => retry.mutate(m.id)}>Retry</button>}
                    {manage && m.status === "UNCERTAIN" && (
                      <div className="flex flex-wrap gap-2">
                        <button className="btn-secondary" onClick={() => resolve.mutate({ id: m.id, outcome: "delivered" })}>It was delivered</button>
                        <button className="btn-secondary" onClick={() => resolve.mutate({ id: m.id, outcome: "not_delivered" })}>It was not delivered</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          <div ref={emails.sentinel} />
          {emails.hasNextPage && <div className="mt-4 flex justify-center"><button className="btn-secondary" onClick={() => void emails.fetchNextPage()}>Load more</button></div>}
        </>
      )}

      {voiding && (
        <Sheet title={`Void ${voiding.number}`} onClose={() => setVoiding(null)}>
          <form onSubmit={(e) => { e.preventDefault(); voidIt.mutate({ id: voiding.id, reason: String(new FormData(e.currentTarget).get("reason")).trim() }); }} className="space-y-3">
            <p className="text-sm">Voiding is permanent. The number is never reused.</p>
            <label htmlFor="reason" className="label">Reason</label>
            <textarea id="reason" name="reason" className="input py-2" rows={3} required minLength={3} maxLength={500} />
            <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setVoiding(null)}>Cancel</button><button className="btn-danger" disabled={voidIt.isPending}>Void invoice</button></div>
          </form>
        </Sheet>
      )}
    </div>
  );
}
