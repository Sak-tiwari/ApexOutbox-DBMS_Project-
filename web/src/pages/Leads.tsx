import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Badge, Empty, ErrorState, Field, ListSkeleton, Sheet, StatusBadge, errorText, useToast } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useCursorList, useDebounced } from "../lib/hooks";
import { LEAD_STATUSES, STATUS_LABEL, type Lead, type LeadStatus, type Page } from "../lib/types";

type LeadPages = InfiniteData<Page<Lead>, string | undefined>;
interface Line { description: string; quantity: string; price: string }

export default function Leads() {
  const { can, me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<LeadStatus | "">("");
  const [review, setReview] = useState(false);
  const [view, setView] = useState<"list" | "board">("list");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pending, setPending] = useState<{ lead: Lead; to: LeadStatus } | null>(null);
  const q = useDebounced(search.trim(), 300);

  const list = useCursorList<Lead>("leads", "/leads", { q: q || undefined, status: status || undefined, needsReview: review || undefined });

  // Optimistic move: patch every cached page now, roll back to the snapshot if the server refuses.
  const move = useMutation({
    mutationFn: (v: { lead: Lead; to: LeadStatus; reason?: string; deal?: unknown }) =>
      api<Lead>(`/leads/${v.lead.id}/transition`, { method: "POST", body: { to: v.to, version: v.lead.version, reason: v.reason, deal: v.deal } }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["leads"] });
      const snapshot = qc.getQueriesData<LeadPages>({ queryKey: ["leads"] });
      qc.setQueriesData<LeadPages>({ queryKey: ["leads"] }, (d) =>
        d && { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.map((l) => (l.id === v.lead.id ? { ...l, status: v.to } : l)) })) });
      return { snapshot };
    },
    onError: (err, _v, ctx) => {
      ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data));
      toast(err instanceof ApiError && err.code === "CONFLICT" ? "Someone else changed this lead. Refreshed." : errorText(err), "error");
    },
    onSuccess: (r) => { if ((r as { conversion?: unknown }).conversion) toast("Won! Client created and invoice queued."); },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ["leads"] }); void qc.invalidateQueries({ queryKey: ["lead-stats"] }); void qc.invalidateQueries({ queryKey: ["invoices"] }); },
  });

  const requestMove = (lead: Lead, to: LeadStatus) => {
    if (to === "CLOSED_WON" || to === "CLOSED_LOST" || lead.status === "CLOSED_LOST") setPending({ lead, to });
    else move.mutate({ lead, to });
  };

  const canWrite = can("leads:write");
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Leads</h1>
        {canWrite && (
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => setImporting(true)}>Import CSV</button>
            <button className="btn-primary" onClick={() => setAdding(true)}>Add lead</button>
          </div>
        )}
      </div>

      <div className="mb-4 space-y-3">
        <input type="search" className="input" placeholder="Search name, company, email…" aria-label="Search leads" value={search} onChange={(e) => setSearch(e.target.value)} inputMode="search" autoComplete="off" />
        <div className="flex flex-wrap items-center gap-2">
          <select className="input w-auto" aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | "")}>
            <option value="">All statuses</option>
            {LEAD_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
          <label className="flex min-h-tap items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={review} onChange={(e) => setReview(e.target.checked)} />Needs review</label>
          <div className="ml-auto flex overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700" role="group" aria-label="View">
            {(["list", "board"] as const).map((v) => (
              <button key={v} aria-pressed={view === v} onClick={() => setView(v)} className={`min-h-tap px-4 text-sm font-medium ${view === v ? "bg-brand-600 text-white" : "bg-white dark:bg-slate-900"}`}>{v === "list" ? "List" : "Board"}</button>
            ))}
          </div>
        </div>
      </div>

      {list.isPending ? <ListSkeleton /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> :
        list.items.length === 0 ? (
          <Empty title={q || status || review ? "No leads match" : "No leads yet"} hint={q || status || review ? "Try clearing the filters." : "Add one, import a CSV, or run the scraper on an approved domain."} />
        ) : view === "list" ? (
          <ul className="space-y-3">{list.items.map((l) => <LeadCard key={l.id} lead={l} onMove={requestMove} canWrite={canWrite} meId={me?.user.id} />)}</ul>
        ) : (
          <Board leads={list.items} onMove={requestMove} canWrite={canWrite} />
        )}

      <div ref={list.sentinel} />
      {list.hasNextPage && <div className="mt-4 flex justify-center"><button className="btn-secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? "Loading…" : "Load more"}</button></div>}

      {adding && <AddLead onClose={() => setAdding(false)} />}
      {importing && <ImportCsv onClose={() => setImporting(false)} />}
      {pending && <MoveDialog lead={pending.lead} to={pending.to} invoicesOn={(me?.tenant.settings.features as { invoices?: boolean } | undefined)?.invoices !== false} onClose={() => setPending(null)} onConfirm={(extra) => { move.mutate({ lead: pending.lead, to: pending.to, ...extra }); setPending(null); }} />}
    </div>
  );
}

function MoveSelect({ lead, onMove }: { lead: Lead; onMove: (l: Lead, to: LeadStatus) => void }) {
  if (!lead.allowedNext.length) return <span className="text-xs text-slate-600 dark:text-slate-400">Final</span>;
  return (
    <select className="input w-auto text-sm" aria-label={`Move ${lead.name}`} value="" onChange={(e) => e.target.value && onMove(lead, e.target.value as LeadStatus)}>
      <option value="">Move to…</option>
      {lead.allowedNext.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
    </select>
  );
}

function LeadCard({ lead, onMove, canWrite, meId }: { lead: Lead; onMove: (l: Lead, to: LeadStatus) => void; canWrite: boolean; meId?: string }) {
  const mine = lead.ownerId === meId;
  return (
    <li className="card flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{lead.name}</p>
          {lead.companyName && <p className="truncate text-sm text-slate-700 dark:text-slate-300">{lead.companyName}</p>}
        </div>
        <StatusBadge status={lead.status} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {lead.email && <a className="underline" href={`mailto:${lead.email}`}>{lead.email}</a>}
        {lead.phone && <a className="underline" href={`tel:${lead.phone.replace(/[^+\d]/g, "")}`}>{lead.phone}</a>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {lead.needsReview && <Badge tone="amber">Needs review</Badge>}
        {mine && <Badge>Yours</Badge>}
        {lead.sourceAdapter !== "manual" && <Badge>{lead.sourceAdapter}</Badge>}
        {canWrite && <div className="ml-auto"><MoveSelect lead={lead} onMove={onMove} /></div>}
      </div>
    </li>
  );
}

// Mobile-friendly board: columns scroll horizontally; there is no drag-and-drop, moving is a tap on "Move to…".
function Board({ leads, onMove, canWrite }: { leads: Lead[]; onMove: (l: Lead, to: LeadStatus) => void; canWrite: boolean }) {
  return (
    <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-3">
      {LEAD_STATUSES.map((s) => {
        const col = leads.filter((l) => l.status === s);
        return (
          <section key={s} aria-label={STATUS_LABEL[s]} className="w-72 flex-none snap-start rounded-xl bg-slate-100 p-3 dark:bg-slate-900">
            <h2 className="mb-2 flex items-center justify-between text-sm font-semibold">{STATUS_LABEL[s]}<span className="text-slate-600 dark:text-slate-400">{col.length}</span></h2>
            <ul className="space-y-2">
              {col.map((l) => (
                <li key={l.id} className="card space-y-2 p-3">
                  <p className="truncate text-sm font-medium">{l.name}</p>
                  {canWrite && <MoveSelect lead={l} onMove={onMove} />}
                </li>
              ))}
              {col.length === 0 && <li className="py-4 text-center text-xs text-slate-600 dark:text-slate-400">Empty</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function MoveDialog({ lead, to, invoicesOn, onClose, onConfirm }: { lead: Lead; to: LeadStatus; invoicesOn: boolean; onClose: () => void; onConfirm: (x: { reason?: string; deal?: unknown }) => void }) {
  const won = to === "CLOSED_WON";
  const [lines, setLines] = useState<Line[]>([{ description: "", quantity: "1", price: "" }]);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const reason = String(f.get("reason") ?? "").trim() || undefined;
    if (!won) return onConfirm({ reason });
    const items = invoicesOn ? lines.map((l) => ({ description: l.description.trim(), quantity: Number(l.quantity), unitAmountMinor: Math.round(Number(l.price) * 100), taxRateBp: Math.round(Number(f.get("tax") ?? 0) * 100) })) : undefined;
    if (items?.some((i) => !i.description || !(i.quantity > 0) || !Number.isFinite(i.unitAmountMinor) || i.unitAmountMinor < 0)) return setError("Fill in every invoice line (description, quantity, price).");
    onConfirm({ reason, deal: { email: String(f.get("email")).trim(), items, sendEmail: f.get("send") === "on", currency: "INR", dueInDays: Number(f.get("due") || 15) } });
  };
  return (
    <Sheet title={won ? `Close "${lead.name}" as won` : to === "CLOSED_LOST" ? "Mark as lost" : "Reopen lead"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
        {won ? (
          <>
            <p className="text-sm">This creates a client{invoicesOn ? " and an invoice" : ""} in one step.</p>
            <Field label="Client email" id="email"><input id="email" name="email" type="email" className="input" inputMode="email" autoComplete="off" defaultValue={lead.email ?? ""} required /></Field>
            {invoicesOn && (
              <>
                {lines.map((l, i) => (
                  <fieldset key={i} className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                    <legend className="px-1 text-xs">Line {i + 1}</legend>
                    <input className="input" aria-label="Description" placeholder="Description" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                    <div className="grid grid-cols-2 gap-2">
                      <input className="input" aria-label="Quantity" inputMode="decimal" placeholder="Qty" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                      <input className="input" aria-label="Unit price" inputMode="decimal" placeholder="Unit price (₹)" value={l.price} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
                    </div>
                  </fieldset>
                ))}
                {lines.length < 50 && <button type="button" className="btn-secondary" onClick={() => setLines([...lines, { description: "", quantity: "1", price: "" }])}>Add line</button>}
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Tax %" id="tax"><input id="tax" name="tax" className="input" inputMode="decimal" defaultValue="18" /></Field>
                  <Field label="Due in (days)" id="due"><input id="due" name="due" className="input" inputMode="numeric" defaultValue="15" /></Field>
                </div>
                <label className="flex min-h-tap items-center gap-2 text-sm"><input type="checkbox" name="send" defaultChecked className="h-5 w-5" />E-mail the invoice to the client</label>
              </>
            )}
          </>
        ) : (
          <Field label="Reason" id="reason" hint={lead.status === "CLOSED_LOST" ? "Why is this lead being reopened?" : "Optional note for the history."}>
            <textarea id="reason" name="reason" className="input py-2" rows={3} maxLength={1000} required={lead.status === "CLOSED_LOST"} />
          </Field>
        )}
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary">Confirm</button></div>
      </form>
    </Sheet>
  );
}

function AddLead({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, string>) => api<Lead>("/leads", { method: "POST", body }),
    onSuccess: () => { toast("Lead added"); void qc.invalidateQueries({ queryKey: ["leads"] }); void qc.invalidateQueries({ queryKey: ["lead-stats"] }); onClose(); },
    onError: (e) => setError(errorText(e)),
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, string> = {};
    for (const k of ["name", "companyName", "email", "phone", "website"]) { const v = String(f.get(k) ?? "").trim(); if (v) body[k] = v; }
    create.mutate(body);
  };
  return (
    <Sheet title="Add lead" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
        <Field label="Name" id="name"><input id="name" name="name" className="input" autoComplete="off" required /></Field>
        <Field label="Company" id="companyName"><input id="companyName" name="companyName" className="input" autoComplete="off" /></Field>
        <Field label="Email" id="email"><input id="email" name="email" type="email" className="input" inputMode="email" autoComplete="off" /></Field>
        <Field label="Phone" id="phone"><input id="phone" name="phone" type="tel" className="input" inputMode="tel" autoComplete="off" /></Field>
        <Field label="Website" id="website"><input id="website" name="website" type="url" className="input" inputMode="url" autoComplete="off" placeholder="https://" /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={create.isPending}>Save</button></div>
      </form>
    </Sheet>
  );
}

function ImportCsv({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<{ inserted: number; duplicates: number; rejected: number; errors?: { row: number; message: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null); setResult(null);
    if (file.size > 512 * 1024) return setError("File is larger than 512 KB.");
    setBusy(true);
    try {
      setResult(await api("/leads/import", { method: "POST", raw: await file.text() }));
      void qc.invalidateQueries({ queryKey: ["leads"] }); void qc.invalidateQueries({ queryKey: ["lead-stats"] });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet title="Import leads from CSV" onClose={onClose}>
      <p className="mb-3 text-sm">Header row required. Columns: name, company, email, phone, website. Up to 1000 rows.</p>
      <input type="file" accept=".csv,text/csv" className="input py-2" aria-label="CSV file" onChange={(e) => void onFile(e.target.files?.[0])} disabled={busy} />
      {busy && <p className="mt-3 text-sm" role="status">Importing…</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
      {result && (
        <div className="mt-3 text-sm" role="status">
          <p>{result.inserted} added, {result.duplicates} duplicates skipped, {result.rejected} rejected.</p>
          {result.errors?.slice(0, 10).map((r) => <p key={r.row} className="text-red-700 dark:text-red-300">Row {r.row}: {r.message}</p>)}
        </div>
      )}
    </Sheet>
  );
}
