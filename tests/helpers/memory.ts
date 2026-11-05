import type { IActivityLog, IDeal, OnboardingStatus } from "../../src/models/Lead";
import type { InvoiceRecord, InvoiceStore, OutboxRecord, OutboxStore } from "../../src/phase4/ports";
import type { LeadRecord, LeadStore, ListLeadsQuery, NewLead, ScrapedLead, TransitionWrite } from "../../src/stores/types";

/**
 * In-memory stores that obey the same atomicity rules as the Mongo stores
 * (each check-and-set below runs with no `await` in the middle, so it is atomic in JS).
 * The Mongo-backed behaviour is verified separately in tests/integration/mongo.test.ts.
 */
export class MemoryLeadStore implements LeadStore {
  leads = new Map<string, LeadRecord>();
  seed(partial: Partial<LeadRecord> & { id: string }): LeadRecord {
    const lead: LeadRecord = {
      name: "Acme Lead", company: "Acme", currentState: "New", ownerId: "userA", version: 0,
      activityHistory: [], onboardingAttempts: 0, onboardingError: "", ...partial,
    };
    this.leads.set(lead.id, lead);
    return lead;
  }
  async findById(id: string) {
    const l = this.leads.get(id);
    return l ? structuredClone(l) : null;
  }
  async applyTransition(w: TransitionWrite) {
    const l = this.leads.get(w.id);
    if (!l || l.version !== w.expectedVersion || l.currentState !== w.from) return null;
    l.currentState = w.to;
    l.version += 1;
    l.activityHistory.push(w.entry as IActivityLog);
    if (w.deal) {
      l.deal = w.deal as IDeal;
      l.onboardingStatus = "PENDING";
      l.onboardingAttempts = 0;
      l.onboardingError = "";
    }
    return structuredClone(l);
  }
  private seq = 0;
  async list(q: ListLeadsQuery) {
    let all = [...this.leads.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (q.ownerId) all = all.filter((l) => l.ownerId === q.ownerId);
    if (q.state) all = all.filter((l) => l.currentState === q.state);
    if (q.followUpBefore) all = all.filter((l) => l.followUpDate && l.followUpDate <= q.followUpBefore!);
    if (q.followUpAfter) all = all.filter((l) => l.followUpDate && l.followUpDate >= q.followUpAfter!);
    if (q.after) all = all.filter((l) => l.id > q.after!);
    const page = all.slice(0, q.limit).map((l) => structuredClone(l));
    return { items: page, nextCursor: all.length > q.limit ? page[page.length - 1].id : null };
  }
  async create(l: NewLead) {
    return structuredClone(this.seed({ id: `N${String(++this.seq).padStart(4, "0")}`, name: l.name, company: l.company, ownerId: l.ownerId, followUpDate: l.followUpDate }));
  }
  async upsertScraped(l: ScrapedLead) {
    const key = `${l.ownerId}|${new URL(l.website).origin}|${l.email ?? "no-email"}`;
    const hit = [...this.leads.values()].find((x) => (x as LeadRecord & { dedupeKey?: string }).dedupeKey === key);
    if (hit) {
      hit.emails = [...new Set([...(hit.emails ?? []), ...l.emails])];
      hit.phones = [...new Set([...(hit.phones ?? []), ...l.phones])];
      return { lead: structuredClone(hit), created: false };
    }
    const lead = this.seed({ id: `N${String(++this.seq).padStart(4, "0")}`, name: l.name, company: l.company, ownerId: l.ownerId, website: l.website, email: l.email, emails: l.emails, phone: l.phones[0], phones: l.phones, source: l.source });
    (lead as LeadRecord & { dedupeKey?: string }).dedupeKey = key;
    return { lead: structuredClone(lead), created: true };
  }
  async cancelPendingOnboarding(id: string) {
    const l = this.leads.get(id);
    if (l && l.onboardingStatus === "PENDING" && l.currentState !== "Closed-Won") { l.onboardingStatus = "CANCELLED"; l.onboardingError = "Lead left Closed-Won before onboarding finished"; }
  }
  async findOnboardingPending(limit: number) {
    return [...this.leads.values()].filter((l) => l.onboardingStatus === "PENDING" && l.currentState === "Closed-Won").slice(0, limit).map((l) => structuredClone(l));
  }
  async markOnboarding(id: string, status: OnboardingStatus, error = "") {
    const l = this.leads.get(id)!;
    l.onboardingStatus = status;
    l.onboardingError = error;
    if (status !== "DONE") l.onboardingAttempts += 1;
  }
}

export class MemoryInvoiceStore implements InvoiceStore {
  invoices = new Map<string, InvoiceRecord>();
  clock = () => new Date();
  seed(partial: Partial<InvoiceRecord> & { id: string }): InvoiceRecord {
    const inv: InvoiceRecord = {
      invoiceNumber: `INV-${partial.id}`,
      snapshot: { clientName: "Asha", email: "asha@example.com", company: "Acme", amount: 100, currency: "INR", description: "Setup", createdAt: new Date() },
      pdfPath: "", status: "PENDING", emailAttempts: 0, emailMessageId: "", lastError: "", updatedAt: new Date(), ...partial,
    };
    this.invoices.set(inv.id, inv);
    return inv;
  }
  private touch(i: InvoiceRecord) { i.updatedAt = this.clock(); }
  async findById(id: string) { const i = this.invoices.get(id); return i ? structuredClone(i) : null; }
  async setPdf(id: string, pdfPath: string) {
    const i = this.invoices.get(id)!;
    if (i.status === "PENDING") { i.pdfPath = pdfPath; i.status = "PDF_READY"; this.touch(i); }
    else if (!i.pdfPath) { i.pdfPath = pdfPath; this.touch(i); }
  }
  async claimForSending(id: string) {
    const i = this.invoices.get(id);
    if (!i || !["PDF_READY", "EMAIL_FAILED"].includes(i.status) || !i.pdfPath) return null;
    i.status = "EMAIL_SENDING"; i.emailAttempts += 1; this.touch(i);
    return structuredClone(i);
  }
  async markSent(id: string, messageId: string) {
    const i = this.invoices.get(id)!;
    if (["EMAIL_SENDING", "EMAIL_UNCERTAIN"].includes(i.status)) { i.status = "EMAIL_SENT"; i.emailMessageId = messageId; i.lastError = ""; this.touch(i); }
  }
  async markFailed(id: string, error: string) {
    const i = this.invoices.get(id)!; if (i.status === "EMAIL_SENDING") { i.status = "EMAIL_FAILED"; i.lastError = error; this.touch(i); }
  }
  async markUncertain(id: string, error: string) {
    const i = this.invoices.get(id)!; if (i.status === "EMAIL_SENDING") { i.status = "EMAIL_UNCERTAIN"; i.lastError = error; this.touch(i); }
  }
  async markAbandoned(id: string, error: string) {
    const i = this.invoices.get(id)!; if (["EMAIL_SENDING", "EMAIL_FAILED"].includes(i.status)) { i.status = "EMAIL_ABANDONED"; i.lastError = error; this.touch(i); }
  }
  async findStuck(olderThan: Date, limit: number) {
    return [...this.invoices.values()].filter((i) => ["PENDING", "PDF_READY", "EMAIL_SENDING", "EMAIL_FAILED"].includes(i.status) && i.updatedAt < olderThan).slice(0, limit).map((i) => i.id);
  }
}

interface MemEvent extends OutboxRecord { status: "PENDING" | "PROCESSING" | "PUBLISHED" | "FAILED"; nextAttemptAt: Date; updatedAt: Date; lastError: string }

export class MemoryOutboxStore implements OutboxStore {
  events = new Map<string, MemEvent>();
  seed(id: string, invoiceId: string, extra: Partial<MemEvent> = {}): MemEvent {
    const e: MemEvent = { id, eventId: `invoice-created:${invoiceId}`, eventType: "INVOICE_CREATED", payload: { invoiceId }, attempts: 0, status: "PENDING", nextAttemptAt: new Date(0), updatedAt: new Date(), lastError: "", ...extra };
    this.events.set(id, e);
    return e;
  }
  async recoverStale(olderThan: Date, maxAttempts: number) {
    let n = 0;
    for (const e of this.events.values()) if (e.status === "PROCESSING" && e.updatedAt < olderThan && e.attempts < maxAttempts) { e.status = "PENDING"; n++; }
    return n;
  }
  async failExhausted(maxAttempts: number) {
    let n = 0;
    for (const e of this.events.values()) if (["PENDING", "PROCESSING"].includes(e.status) && e.attempts >= maxAttempts && e.updatedAt < new Date(Date.now() - 60_000)) { e.status = "FAILED"; n++; }
    return n;
  }
  async claimNext(now: Date, maxAttempts: number) {
    const due = [...this.events.values()].filter((e) => e.status === "PENDING" && e.attempts < maxAttempts && e.nextAttemptAt <= now);
    const e = due[0];
    if (!e) return null;
    e.status = "PROCESSING"; e.attempts += 1; e.updatedAt = new Date();
    return { id: e.id, eventId: e.eventId, eventType: e.eventType, payload: e.payload, attempts: e.attempts };
  }
  async markPublished(id: string) { const e = this.events.get(id)!; e.status = "PUBLISHED"; e.lastError = ""; }
  async markRetry(id: string, error: string, nextAttemptAt: Date, final: boolean) {
    const e = this.events.get(id)!; e.status = final ? "FAILED" : "PENDING"; e.lastError = error; e.nextAttemptAt = nextAttemptAt; e.updatedAt = new Date();
  }
}

import type { ScrapeJobRecord, ScrapeJobStore, ScrapeResultWrite } from "../../src/scraper/jobs";

export class MemoryScrapeJobStore implements ScrapeJobStore {
  jobs: ScrapeJobRecord[] = [];
  private seq = 0;
  async enqueue(ownerId: string, url: string) {
    const active = this.jobs.find((j) => j.ownerId === ownerId && j.url === url && (j.status === "QUEUED" || j.status === "RUNNING"));
    if (active) return { job: structuredClone(active), created: false };
    const job: ScrapeJobRecord = { id: `J${String(++this.seq).padStart(4, "0")}`, ownerId, url, status: "QUEUED", attempts: 0, title: "", emails: [], phones: [], errorCode: "", error: "", createdAt: new Date() };
    this.jobs.push(job);
    return { job: structuredClone(job), created: true };
  }
  async countActive(ownerId: string) { return this.jobs.filter((j) => j.ownerId === ownerId && (j.status === "QUEUED" || j.status === "RUNNING")).length; }
  async list(ownerId: string, limit: number) { return this.jobs.filter((j) => j.ownerId === ownerId).slice().reverse().slice(0, limit).map((j) => structuredClone(j)); }
  async findById(id: string) { const j = this.jobs.find((x) => x.id === id); return j ? structuredClone(j) : null; }
  async claimNext() {
    const j = this.jobs.find((x) => x.status === "QUEUED");
    if (!j) return null;
    j.status = "RUNNING"; j.attempts += 1; j.startedAt = new Date();
    return structuredClone(j);
  }
  async complete(id: string, r: ScrapeResultWrite) { Object.assign(this.jobs.find((x) => x.id === id)!, { status: "DONE", ...r, finishedAt: new Date() }); }
  async fail(id: string, errorCode: string, error: string) { Object.assign(this.jobs.find((x) => x.id === id)!, { status: "FAILED", errorCode, error, finishedAt: new Date() }); }
  async recoverStale(olderThanMs: number, maxAttempts: number) {
    let n = 0;
    for (const j of this.jobs) {
      if (j.status !== "RUNNING" || !j.startedAt || Date.now() - j.startedAt.getTime() < olderThanMs) continue;
      if (j.attempts < maxAttempts) { j.status = "QUEUED"; n++; } else { j.status = "FAILED"; j.errorCode = "WORKER_LOST"; }
    }
    return n;
  }
}
