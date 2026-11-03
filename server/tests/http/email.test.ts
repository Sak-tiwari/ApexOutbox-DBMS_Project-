import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { backoffSeconds, EmailWorker } from "../../src/email/worker.js";
import { classifySmtpError, EmailPermanentError, EmailUncertainError, type Mailer, type OutgoingMail } from "../../src/email/mailer.js";
import { InvoicesService } from "../../src/invoices/service.js";
import { InvoiceStorage } from "../../src/invoices/storage.js";
import { createLogger } from "../../src/logger.js";
import { bearer, makeApp, newAccount, userWithRole } from "../helpers/app.js";
import { appPool, closePools, ownerPool } from "../helpers/db.js";
import os from "node:os";
import path from "node:path";

afterAll(closePools);

const ITEMS = [{ description: "Retainer", quantity: 1, unitAmountMinor: 100_000, taxRateBp: 1800 }];

/** A mailer whose behaviour each test scripts. Records every message it was asked to send. */
function fakeMailer(script: (mail: OutgoingMail, call: number) => Promise<void> | void = () => {}) {
  const sent: OutgoingMail[] = [];
  let calls = 0;
  const mailer: Mailer = {
    async send(mail) {
      calls++;
      await script(mail, calls);
      sent.push(mail);
      return { providerMessageId: `<provider-${calls}@mail.example.com>` };
    },
  };
  return { mailer, sent, calls: () => calls };
}
const worker = (mailer: Mailer, extra: Partial<ConstructorParameters<typeof EmailWorker>[0]> = {}) =>
  new EmailWorker({
    db: appPool(), log: createLogger("silent"), mailer, messageIdDomain: "apex.example.com",
    invoices: new InvoicesService(appPool(), new InvoiceStorage(path.join(os.tmpdir(), "apex-test-invoices"))), ...extra,
  });

async function setup(label = "mail") {
  const ctx = makeApp();
  const owner = await newAccount(ctx, label);
  const api = (token = owner.accessToken) => ({
    post: (url: string, body?: object) => request(ctx.app).post(url).set(bearer(token)).send(body),
    get: (url: string) => request(ctx.app).get(url).set(bearer(token)),
  });
  const won = async () => {
    const t = randomUUID().slice(0, 8);
    const lead = (await api().post("/api/leads", { name: `Mail Client ${t}`, website: `https://m-${t}.example.com` })).body;
    await api().post(`/api/leads/${lead.id}/transition`, { to: "CONTACTED", version: 0 });
    await api().post(`/api/leads/${lead.id}/transition`, { to: "NEGOTIATION", version: 1 });
    const res = await api().post(`/api/leads/${lead.id}/transition`, { to: "CLOSED_WON", version: 2, deal: { email: `pay-${t}@client.example.com`, items: ITEMS } });
    expect(res.status).toBe(200);
    const invoiceId = res.body.conversion.invoiceId as string;
    const emailId = (await ownerPool().query("SELECT id FROM email_outbox WHERE invoice_id = $1", [invoiceId])).rows[0].id as string;
    return { invoiceId, emailId, to: `pay-${t}@client.example.com` };
  };
  const mail = async (id: string) => (await ownerPool().query("SELECT * FROM email_outbox WHERE id = $1", [id])).rows[0];
  const invoiceStatus = async (id: string) => (await ownerPool().query("SELECT status FROM invoices WHERE id = $1", [id])).rows[0].status as string;
  const due = (id: string) => ownerPool().query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [id]);
  return { ctx, owner, api, won, mail, invoiceStatus, due };
}

beforeEach(async () => {
  // The worker claims across all workspaces; park whatever earlier tests left behind.
  await ownerPool().query("UPDATE email_outbox SET status = 'ABANDONED' WHERE status IN ('PENDING', 'SENDING')");
});

describe("sending", () => {
  it("sends the invoice PDF once, marks the e-mail SENT and the invoice SENT", async () => {
    const { won, mail, invoiceStatus } = await setup();
    const { invoiceId, emailId, to } = await won();
    const fm = fakeMailer();
    expect(await worker(fm.mailer).runOnce()).toBe(true);

    expect(fm.sent).toHaveLength(1);
    const m = fm.sent[0]!;
    expect(m).toMatchObject({ to, messageId: `<${emailId}@apex.example.com>` });
    expect(m.subject).toMatch(/^Invoice INV-00001 from /);
    expect(m.text).toContain("INR 1,180.00");
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments![0]).toMatchObject({ filename: "INV-00001.pdf", contentType: "application/pdf" });
    expect(m.attachments![0]!.content.subarray(0, 5).toString()).toBe("%PDF-");

    const row = await mail(emailId);
    expect(row).toMatchObject({ status: "SENT", attempts: 1, provider_message_id: "<provider-1@mail.example.com>", last_error: null, locked_by: null });
    expect(row.sent_at).not.toBeNull();
    expect(await invoiceStatus(invoiceId)).toBe("SENT");
    expect(await worker(fakeMailer().mailer).runOnce()).toBe(false); // nothing left to do
  });

  it("three workers racing for one e-mail send it exactly once", async () => {
    const { won } = await setup();
    await won();
    const fm = fakeMailer(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const results = await Promise.all([worker(fm.mailer).runOnce(), worker(fm.mailer).runOnce(), worker(fm.mailer).runOnce()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fm.calls()).toBe(1);
  });

  it("does not send for an e-mail that is not due yet, or when the workspace is suspended", async () => {
    const { owner, won, mail, due } = await setup();
    const { emailId } = await won();
    await ownerPool().query("UPDATE email_outbox SET next_attempt_at = now() + interval '1 hour' WHERE id = $1", [emailId]);
    const fm = fakeMailer();
    expect(await worker(fm.mailer).runOnce()).toBe(false);
    await due(emailId);
    await ownerPool().query("UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1", [owner.tenantId]);
    expect(await worker(fm.mailer).runOnce()).toBe(false);
    expect(fm.calls()).toBe(0);
    expect((await mail(emailId)).status).toBe("PENDING");
  });
});

describe("failures", () => {
  it("a temporary failure is retried later with back-off, then succeeds", async () => {
    const { won, mail, due, invoiceStatus } = await setup();
    const { emailId, invoiceId } = await won();
    const fm = fakeMailer((_m, call) => { if (call === 1) throw new Error("421 try again later"); });
    const w = worker(fm.mailer);
    await w.runOnce();
    const after1 = await mail(emailId);
    expect(after1).toMatchObject({ status: "PENDING", attempts: 1, last_error: "421 try again later", locked_by: null });
    expect(new Date(after1.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 20_000); // back-off applied
    expect(await w.runOnce()).toBe(false); // not due yet
    await due(emailId);
    await w.runOnce();
    expect(await mail(emailId)).toMatchObject({ status: "SENT", attempts: 2, last_error: null });
    expect(await invoiceStatus(invoiceId)).toBe("SENT");
    expect(fm.sent).toHaveLength(1);
  });

  it("gives up after max_attempts (ABANDONED) and the invoice stays ISSUED", async () => {
    const { won, mail, due, invoiceStatus } = await setup();
    const { emailId, invoiceId } = await won();
    await ownerPool().query("UPDATE email_outbox SET max_attempts = 2 WHERE id = $1", [emailId]);
    const w = worker(fakeMailer(() => { throw new Error("connection refused"); }).mailer);
    await w.runOnce();
    await due(emailId);
    await w.runOnce();
    expect(await mail(emailId)).toMatchObject({ status: "ABANDONED", attempts: 2 });
    expect(await invoiceStatus(invoiceId)).toBe("ISSUED");
    expect(await w.runOnce()).toBe(false);
  });

  it("a definite rejection (bad mailbox) is FAILED immediately, and a person can retry after fixing it", async () => {
    const { api, won, mail } = await setup();
    const { emailId, invoiceId } = await won();
    let reject = true;
    const fm = fakeMailer(() => { if (reject) throw new EmailPermanentError("550 mailbox does not exist"); });
    const w = worker(fm.mailer);
    await w.runOnce();
    expect(await mail(emailId)).toMatchObject({ status: "FAILED", attempts: 1, last_error: "550 mailbox does not exist" });
    expect(await w.runOnce()).toBe(false);

    reject = false;
    expect((await api().post(`/api/emails/${emailId}/retry`)).status).toBe(202);
    expect((await mail(emailId)).max_attempts).toBeGreaterThanOrEqual(4);
    await w.runOnce();
    expect(await mail(emailId)).toMatchObject({ status: "SENT", attempts: 2 });
    expect(invoiceId).toBeTruthy();
  });

  it("an unknown outcome is UNCERTAIN and is NEVER sent again automatically", async () => {
    const { won, mail, due } = await setup();
    const { emailId } = await won();
    const fm = fakeMailer(() => { throw new EmailUncertainError("ETIMEDOUT while sending"); });
    const w = worker(fm.mailer);
    await w.runOnce();
    expect(await mail(emailId)).toMatchObject({ status: "UNCERTAIN", attempts: 1 });
    await due(emailId);
    expect(await w.runOnce()).toBe(false);
    expect(await w.runOnce()).toBe(false);
    expect(fm.calls()).toBe(1);
  });

  it("a worker that died mid-send leaves the row UNCERTAIN (not re-sent) once its lock goes stale", async () => {
    const { won, mail } = await setup();
    const { emailId } = await won();
    await ownerPool().query("UPDATE email_outbox SET status = 'SENDING', locked_by = 'dead-worker', locked_at = now() - interval '1 hour', attempts = 1 WHERE id = $1", [emailId]);
    const fm = fakeMailer();
    expect(await worker(fm.mailer).runOnce()).toBe(false);
    expect(await mail(emailId)).toMatchObject({ status: "UNCERTAIN" });
    expect((await mail(emailId)).last_error).toMatch(/delivery status unknown/);
    expect(fm.calls()).toBe(0);
  });

  it("a worker that is merely slow (fresh lock) is left alone", async () => {
    const { won, mail } = await setup();
    const { emailId } = await won();
    await ownerPool().query("UPDATE email_outbox SET status = 'SENDING', locked_by = 'busy', locked_at = now() WHERE id = $1", [emailId]);
    await worker(fakeMailer().mailer).runOnce();
    expect((await mail(emailId)).status).toBe("SENDING");
  });

  it("if the invoice PDF cannot be built, the e-mail fails safely without contacting the provider", async () => {
    const { won, mail } = await setup();
    const { emailId, invoiceId } = await won();
    const broken = new InvoicesService(appPool(), new InvoiceStorage(path.join(os.tmpdir(), "apex-test-invoices")));
    broken.ensurePdf = async () => { throw new Error("disk full"); };
    const fm = fakeMailer();
    await worker(fm.mailer, { invoices: broken }).runOnce();
    expect(fm.calls()).toBe(0);
    expect(await mail(emailId)).toMatchObject({ status: "PENDING", attempts: 1, last_error: "disk full" });
    expect(invoiceId).toBeTruthy();
  });
});

describe("humans resolving problems", () => {
  async function uncertain() {
    const s = await setup("resolve");
    const sent = await s.won();
    await ownerPool().query("UPDATE email_outbox SET status = 'UNCERTAIN', attempts = 1, last_error = 'ETIMEDOUT' WHERE id = $1", [sent.emailId]);
    return { ...s, ...sent };
  }

  it("'delivered' closes it as SENT and marks the invoice SENT; 'not delivered' queues one more attempt", async () => {
    const a = await uncertain();
    expect((await a.api().post(`/api/emails/${a.emailId}/resolve`, { outcome: "delivered" })).status).toBe(204);
    expect(await a.mail(a.emailId)).toMatchObject({ status: "SENT" });
    expect(await a.invoiceStatus(a.invoiceId)).toBe("SENT");

    const b = await uncertain();
    expect((await b.api().post(`/api/emails/${b.emailId}/resolve`, { outcome: "not_delivered" })).status).toBe(204);
    expect(await b.mail(b.emailId)).toMatchObject({ status: "PENDING" });
    const fm = fakeMailer();
    await worker(fm.mailer).runOnce();
    expect(fm.sent).toHaveLength(1);
    const audit = await ownerPool().query("SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'email.resolved'", [b.owner.tenantId]);
    expect(audit.rows[0].metadata).toEqual({ outcome: "not_delivered" });
  });

  it("only UNCERTAIN e-mails can be resolved and only FAILED/ABANDONED ones retried; members cannot do either", async () => {
    const s = await setup("guard");
    const member = await userWithRole(s.ctx, s.owner.accessToken, "MEMBER");
    const { emailId } = await s.won();
    expect((await s.api().post(`/api/emails/${emailId}/resolve`, { outcome: "delivered" })).body.error.code).toBe("INVALID_EMAIL_STATE");
    expect((await s.api().post(`/api/emails/${emailId}/retry`)).body.error.code).toBe("INVALID_EMAIL_STATE");
    expect((await s.api().post(`/api/emails/${emailId}/resolve`, { outcome: "maybe" })).status).toBe(400);
    expect((await s.api(member.accessToken).post(`/api/emails/${emailId}/retry`)).status).toBe(403);
    expect((await s.api(member.accessToken).post(`/api/emails/${emailId}/resolve`, { outcome: "delivered" })).status).toBe(403);
    expect((await s.api(member.accessToken).get("/api/emails")).status).toBe(200);
    expect((await s.api().post(`/api/emails/${randomUUID()}/retry`)).status).toBe(404);
  });
});

describe("e-mail API", () => {
  it("lists newest first with a status filter and counts what needs attention", async () => {
    const s = await setup("list");
    const a = await s.won();
    const b = await s.won();
    await ownerPool().query("UPDATE email_outbox SET status = 'FAILED' WHERE id = $1", [a.emailId]);
    const list = await s.api().get("/api/emails");
    expect(list.body.items.map((e: { id: string }) => e.id)).toEqual([b.emailId, a.emailId]);
    expect(list.body.items[0]).toMatchObject({ status: "PENDING", invoiceNumber: "INV-00002", kind: "INVOICE" });
    expect((await s.api().get("/api/emails?status=FAILED")).body.items.map((e: { id: string }) => e.id)).toEqual([a.emailId]);
    expect((await s.api().get("/api/emails?status=NOPE")).status).toBe(400);
    expect((await s.api().get("/api/emails/stats")).body).toMatchObject({ byStatus: { PENDING: 1, FAILED: 1, SENT: 0 }, needsAttention: 1 });
  });

  it("another workspace sees nothing and cannot retry or resolve", async () => {
    const a = await setup("isoMA");
    const b = await setup("isoMB");
    const { emailId } = await a.won();
    await ownerPool().query("UPDATE email_outbox SET status = 'UNCERTAIN' WHERE id = $1", [emailId]);
    expect((await b.api().get("/api/emails")).body.items).toEqual([]);
    expect((await b.api().post(`/api/emails/${emailId}/resolve`, { outcome: "delivered" })).status).toBe(404);
    expect((await b.api().post(`/api/emails/${emailId}/retry`)).status).toBe(404);
    expect((await a.mail(emailId)).status).toBe("UNCERTAIN");
  });
});

describe("helpers", () => {
  it("back-off doubles from 30 s and is capped at one hour", () => {
    expect([1, 2, 3, 4, 10].map(backoffSeconds)).toEqual([30, 60, 120, 240, 3600]);
  });
  it("classifies SMTP errors: 5xx/EENVELOPE permanent, dropped connections uncertain, the rest retryable", () => {
    expect(classifySmtpError({ responseCode: 550, message: "no such user" })).toBeInstanceOf(EmailPermanentError);
    expect(classifySmtpError({ code: "EENVELOPE", message: "bad address" })).toBeInstanceOf(EmailPermanentError);
    for (const code of ["ETIMEDOUT", "ECONNRESET", "ESOCKET", "EPIPE"]) expect(classifySmtpError({ code, message: "x" })).toBeInstanceOf(EmailUncertainError);
    const plain = classifySmtpError({ responseCode: 421, message: "busy" });
    expect(plain).not.toBeInstanceOf(EmailPermanentError);
    expect(plain).not.toBeInstanceOf(EmailUncertainError);
  });
});
