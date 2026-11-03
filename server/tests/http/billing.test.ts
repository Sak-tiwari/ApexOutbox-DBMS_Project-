import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { withTenant } from "../../src/db/pool.js";
import { bearer, makeApp, newAccount, userWithRole, type TestCtx } from "../helpers/app.js";
import { appPool, closePools, expectPgError, ownerPool } from "../helpers/db.js";

afterAll(closePools);

const tag = () => randomUUID().slice(0, 8);
const ITEMS = [{ description: "Website redesign", quantity: 2, unitAmountMinor: 50_000, taxRateBp: 1800 }];

async function setup(label = "bill") {
  const ctx = makeApp();
  const owner = await newAccount(ctx, label);
  const api = (token = owner.accessToken) => ({
    post: (url: string, body?: object) => request(ctx.app).post(url).set(bearer(token)).send(body),
    get: (url: string) => request(ctx.app).get(url).set(bearer(token)),
    patch: (url: string, body: object) => request(ctx.app).patch(url).set(bearer(token)).send(body),
  });
  /** Creates a lead and walks it to NEGOTIATION, ready to be won. */
  const negotiating = async (token = owner.accessToken, over: object = {}) => {
    const t = tag();
    const created = await api(token).post("/api/leads", { name: `Client ${t}`, companyName: `Co ${t}`, phone: "+91 98765 43210", website: `https://c-${t}.example.com`, ...over });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    let v = 0;
    for (const to of ["CONTACTED", "NEGOTIATION"]) {
      const r = await api(token).post(`/api/leads/${created.body.id}/transition`, { to, version: v++ });
      expect(r.status).toBe(200);
    }
    return { id: created.body.id as string, version: 2, email: `billing-${t}@client.example.com` };
  };
  const win = (lead: { id: string; version: number; email: string }, deal: object = {}, token = owner.accessToken) =>
    api(token).post(`/api/leads/${lead.id}/transition`, { to: "CLOSED_WON", version: lead.version, deal: { email: lead.email, items: ITEMS, ...deal } });
  const won = async (deal: object = {}, token = owner.accessToken) => {
    const lead = await negotiating(token);
    const res = await win(lead, deal, token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { lead, res, conversion: res.body.conversion as { clientId: string; invoiceId: string; invoiceNumber: string; totalMinor: number; emailQueued: boolean } };
  };
  return { ctx, owner, api, negotiating, win, won };
}

describe("closing a lead as won", () => {
  it("creates the client, the invoice (with next number and totals), history and the queued e-mail together", async () => {
    const { owner, won } = await setup();
    const { lead, res, conversion } = await won({ billingAddress: { line1: "12 MG Road", city: "Pune", postalCode: "411001", country: "India" }, taxId: "27ABCDE1234F1Z5" });
    expect(res.body).toMatchObject({ status: "CLOSED_WON", version: 3, allowedNext: [] });
    expect(res.body.clientId).toBe(conversion.clientId);
    expect(conversion).toMatchObject({ invoiceNumber: "INV-00001", totalMinor: 118_000, emailQueued: true });

    const db = ownerPool();
    const client = (await db.query("SELECT * FROM clients WHERE id = $1", [conversion.clientId])).rows[0];
    expect(client).toMatchObject({ tenant_id: owner.tenantId, lead_id: lead.id, email: lead.email, tax_id: "27ABCDE1234F1Z5", phone: "+91 98765 43210" });
    expect(client.billing_address).toEqual({ line1: "12 MG Road", city: "Pune", postalCode: "411001", country: "India" });
    const inv = (await db.query("SELECT * FROM invoices WHERE id = $1", [conversion.invoiceId])).rows[0];
    expect(inv).toMatchObject({ status: "ISSUED", number: "INV-00001", currency: "INR", subtotal_minor: 100000, tax_minor: 18000, total_minor: 118000, idempotency_key: `conversion:${lead.id}` });
    expect(inv.snapshot.client.name).toBe(client.name);
    expect((await db.query("SELECT count(*)::int AS n FROM invoice_items WHERE invoice_id = $1", [inv.id])).rows[0].n).toBe(1);
    const mail = (await db.query("SELECT * FROM email_outbox WHERE invoice_id = $1", [inv.id])).rows[0];
    expect(mail).toMatchObject({ status: "PENDING", kind: "INVOICE", to_email: lead.email });
    expect(mail.subject).toMatch(/^Invoice INV-00001 from /);
    expect(mail.body_text).toContain("INR 1,180.00");
    const acts = (await db.query("SELECT type FROM activities WHERE lead_id = $1 ORDER BY at, type", [lead.id])).rows.map((r) => r.type);
    expect(acts).toContain("CONVERTED");
    expect((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action IN ('lead.won','invoice.issued')", [owner.tenantId])).rows[0].n).toBe(2);
  });

  it("uses the workspace's invoice settings (prefix, currency, default tax) and per-line overrides", async () => {
    const { api, negotiating, win } = await setup();
    await api().patch("/api/tenant/settings", { invoice: { prefix: "ACME", currency: "USD", defaultTaxRateBp: 500 } });
    const lead = await negotiating();
    const res = await win(lead, { items: [{ description: "A", quantity: 1, unitAmountMinor: 10_000 }, { description: "B", quantity: 1, unitAmountMinor: 10_000, taxRateBp: 0 }] });
    expect(res.body.conversion).toMatchObject({ invoiceNumber: "ACME-00001", totalMinor: 20_500 });
    const inv = await api().get(`/api/invoices/${res.body.conversion.invoiceId}`);
    expect(inv.body.invoice.currency).toBe("USD");
  });

  it("refuses incomplete or hostile deals without changing anything", async () => {
    const { api, negotiating, win } = await setup();
    const lead = await negotiating();
    const noDeal = await api().post(`/api/leads/${lead.id}/transition`, { to: "CLOSED_WON", version: 2 });
    expect(noDeal.body.error.code).toBe("DEAL_REQUIRED");
    expect((await win(lead, { items: undefined })).body.error.code).toBe("DEAL_ITEMS_REQUIRED");
    for (const bad of [
      { items: [{ description: "x", quantity: 0, unitAmountMinor: 1 }] },
      { items: [{ description: "x", quantity: 1, unitAmountMinor: -5 }] },
      { items: [{ description: "x", quantity: 1, unitAmountMinor: 1.5 }] },
      { items: [{ description: "x", quantity: 1.0005, unitAmountMinor: 1 }] },
      { items: [{ description: "x", quantity: 1, unitAmountMinor: 1, taxRateBp: 10_001 }] },
      { items: [{ description: "x", quantity: 1, unitAmountMinor: 1e12 }] },
      { items: [{ description: "x", quantity: 1, unitAmountMinor: 1, price: 5 }] },
      { items: Array.from({ length: 51 }, () => ({ description: "x", quantity: 1, unitAmountMinor: 1 })) },
      { email: "nope" },
      { currency: "rupees" },
      { dueInDays: 9999 },
      { status: "PAID" },
    ]) {
      expect((await win(lead, bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    const huge = { description: "x", quantity: 1_000_000, unitAmountMinor: 100_000_000_000, taxRateBp: 10_000 };
    expect((await win(lead, { items: Array(50).fill(huge) })).body.error.code).toBe("INVOICE_TOO_LARGE");
    const other = await api().post(`/api/leads/${lead.id}/transition`, { to: "FOLLOW_UP", version: 2, deal: { email: "a@b.example.com" } });
    expect(other.body.error.code).toBe("DEAL_NOT_ALLOWED");
    const db = ownerPool();
    expect((await db.query("SELECT status, version, client_id FROM leads WHERE id = $1", [lead.id])).rows[0]).toEqual({ status: "NEGOTIATION", version: 2, client_id: null });
    expect((await db.query("SELECT count(*)::int AS n FROM clients WHERE lead_id = $1", [lead.id])).rows[0].n).toBe(0);
  });

  it("is all-or-nothing: if queuing the e-mail fails, no client, no invoice, and the number is not burned", async () => {
    const { owner, api, negotiating, win } = await setup();
    const lead = await negotiating();
    const db = ownerPool();
    const fn = `fail_${tag()}`;
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated outbox failure'; END $$`);
    await db.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON email_outbox FOR EACH ROW WHEN (NEW.tenant_id = '${owner.tenantId}') EXECUTE FUNCTION ${fn}()`);
    try {
      const failed = await win(lead);
      expect(failed.status).toBe(500);
      expect((await db.query("SELECT status, version, client_id FROM leads WHERE id = $1", [lead.id])).rows[0]).toEqual({ status: "NEGOTIATION", version: 2, client_id: null });
      expect((await db.query("SELECT count(*)::int AS n FROM invoices WHERE tenant_id = $1", [owner.tenantId])).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int AS n FROM clients WHERE tenant_id = $1", [owner.tenantId])).rows[0].n).toBe(0);
    } finally {
      await db.query(`DROP TRIGGER ${fn} ON email_outbox`);
      await db.query(`DROP FUNCTION ${fn}()`);
    }
    const retry = await win(lead);
    expect(retry.status).toBe(200);
    expect(retry.body.conversion.invoiceNumber).toBe("INV-00001"); // gapless: the failed attempt did not consume a number
    expect((await api().get("/api/leads/stats")).body.byStatus.CLOSED_WON).toBe(1);
  });

  it("numbers stay unique and gapless when many leads are won at the same time", async () => {
    const { owner, api, negotiating, win } = await setup();
    const leads = await Promise.all(Array.from({ length: 6 }, () => negotiating()));
    const results = await Promise.all(leads.map((l) => win(l)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const numbers = results.map((r) => r.body.conversion.invoiceNumber).sort();
    expect(numbers).toEqual(["INV-00001", "INV-00002", "INV-00003", "INV-00004", "INV-00005", "INV-00006"]);
    expect((await ownerPool().query("SELECT last_number FROM invoice_counters WHERE tenant_id = $1", [owner.tenantId])).rows[0].last_number).toBe(6);
    expect((await api().get("/api/invoices?limit=50")).body.items).toHaveLength(6);
  });

  it("two simultaneous wins of one lead produce exactly one client and one invoice", async () => {
    const { owner, negotiating, win } = await setup();
    const lead = await negotiating();
    const [a, b] = await Promise.all([win(lead), win(lead)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const db = ownerPool();
    expect((await db.query("SELECT count(*)::int AS n FROM clients WHERE tenant_id = $1", [owner.tenantId])).rows[0].n).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM invoices WHERE tenant_id = $1", [owner.tenantId])).rows[0].n).toBe(1);
  });

  it("a won lead is final: no reopening, no deleting", async () => {
    const { api, won } = await setup();
    const { lead } = await won();
    const reopen = await api().post(`/api/leads/${lead.id}/transition`, { to: "NEGOTIATION", version: 3, reason: "Customer changed mind" });
    expect(reopen.status).toBe(422);
    expect(reopen.body.error.code).toBe("INVALID_TRANSITION");
    expect((await api().get(`/api/leads/${lead.id}`)).body.lead.allowedNext).toEqual([]);
    const del = await request(makeApp().app).delete(`/api/leads/${lead.id}`);
    expect(del.status).toBe(401);
  });

  it("with invoicing off only the client is created; with e-mail off no e-mail is queued", async () => {
    const { api, negotiating, win } = await setup();
    await api().patch("/api/tenant/settings", { features: { email: false } });
    const a = await win(await negotiating());
    expect(a.body.conversion).toMatchObject({ emailQueued: false });
    expect(a.body.conversion.invoiceNumber).toBe("INV-00001");
    expect((await api().get(`/api/invoices/${a.body.conversion.invoiceId}`)).body.emails).toEqual([]);

    await api().patch("/api/tenant/settings", { features: { invoices: false } });
    const lead = await negotiating();
    const b = await win(lead, { items: undefined });
    expect(b.status).toBe(200);
    expect(b.body.conversion).toMatchObject({ invoiceId: null, invoiceNumber: null, emailQueued: false });
    expect(b.body.conversion.clientId).toBeTruthy();
  });

  it("members may win their own leads but not other people's", async () => {
    const { ctx, owner, api, negotiating, win } = await setup();
    const m1 = await userWithRole(ctx, owner.accessToken, "MEMBER", "w1");
    const m2 = await userWithRole(ctx, owner.accessToken, "MEMBER", "w2");
    const mine = await negotiating(m1.accessToken);
    expect((await win(mine, {}, m2.accessToken)).status).toBe(403);
    expect((await win(mine, {}, m1.accessToken)).status).toBe(200);
    expect(api(m2.accessToken)).toBeTruthy();
  });
});

describe("issued invoices are immutable (enforced by the database)", () => {
  async function issued() {
    const s = await setup("imm");
    const { conversion } = await s.won();
    return { ...s, conversion };
  }
  const run = (tenantId: string, sql: string, params: unknown[] = []) => withTenant(appPool(), tenantId, (tx) => tx.query(sql, params));

  it("refuses changes to number, amounts, currency, client and snapshot even from the app role", async () => {
    const { owner, conversion } = await issued();
    for (const sql of [
      "UPDATE invoices SET total_minor = 1, subtotal_minor = 1, tax_minor = 0 WHERE id = $1",
      "UPDATE invoices SET number = 'INV-99999' WHERE id = $1",
      "UPDATE invoices SET currency = 'USD' WHERE id = $1",
      "UPDATE invoices SET snapshot = '{}'::jsonb WHERE id = $1",
      "UPDATE invoices SET issued_at = now() - interval '1 year' WHERE id = $1",
      "UPDATE invoice_items SET unit_amount_minor = 1 WHERE invoice_id = $1",
      "DELETE FROM invoice_items WHERE invoice_id = $1",
    ]) {
      await expectPgError(run(owner.tenantId, sql, [conversion.invoiceId]), "42501");
    }
  });

  it("PAID and VOID are final, and SENT never goes back to ISSUED", async () => {
    const { owner, api, conversion } = await issued();
    await run(owner.tenantId, "UPDATE invoices SET status = 'SENT' WHERE id = $1", [conversion.invoiceId]);
    await expectPgError(run(owner.tenantId, "UPDATE invoices SET status = 'ISSUED' WHERE id = $1", [conversion.invoiceId]), "42501");
    expect((await api().post(`/api/invoices/${conversion.invoiceId}/mark-paid`)).status).toBe(200);
    await expectPgError(run(owner.tenantId, "UPDATE invoices SET status = 'ISSUED' WHERE id = $1", [conversion.invoiceId]), "42501");
    await expectPgError(run(owner.tenantId, "UPDATE invoices SET status = 'VOID' WHERE id = $1", [conversion.invoiceId]), "42501");
  });

  it("the immutability guard also holds for the schema owner, and an issued invoice cannot lose its number", async () => {
    const { conversion } = await issued();
    await expectPgError(ownerPool().query("UPDATE invoices SET number = NULL WHERE id = $1", [conversion.invoiceId]), "42501");
    await expectPgError(ownerPool().query("UPDATE invoices SET total_minor = total_minor + 1 WHERE id = $1", [conversion.invoiceId]), "42501");
  });
});

describe("invoice API", () => {
  it("lists newest first with search, status and overdue filters, and shows detail with items and e-mail history", async () => {
    const { owner, api, won } = await setup();
    const a = await won();
    const b = await won();
    const list = await api().get("/api/invoices?limit=1");
    expect(list.body.items[0].id).toBe(b.conversion.invoiceId);
    expect(list.body.nextCursor).toBeTruthy();
    expect((await api().get(`/api/invoices?limit=1&cursor=${encodeURIComponent(list.body.nextCursor)}`)).body.items[0].id).toBe(a.conversion.invoiceId);
    expect((await api().get("/api/invoices?q=inv-00002")).body.items.map((i: { id: string }) => i.id)).toEqual([b.conversion.invoiceId]);
    expect((await api().get("/api/invoices?status=PAID")).body.items).toEqual([]);
    expect((await api().get("/api/invoices?status=NOPE")).status).toBe(400);
    expect((await api().get("/api/invoices?overdue=true")).body.items).toEqual([]);
    await ownerPool().query("ALTER TABLE invoices DISABLE TRIGGER invoices_guard");
    await ownerPool().query("UPDATE invoices SET due_at = now() - interval '2 days' WHERE id = $1", [a.conversion.invoiceId]);
    await ownerPool().query("ALTER TABLE invoices ENABLE TRIGGER invoices_guard");
    const overdue = await api().get("/api/invoices?overdue=true");
    expect(overdue.body.items.map((i: { id: string }) => i.id)).toEqual([a.conversion.invoiceId]);
    expect(overdue.body.items[0].overdue).toBe(true);

    const detail = await api().get(`/api/invoices/${a.conversion.invoiceId}`);
    expect(detail.body.invoice).toMatchObject({ number: "INV-00001", status: "ISSUED", totalMinor: 118_000, clientName: expect.stringMatching(/^Client /) });
    expect(detail.body.items).toHaveLength(1);
    expect(detail.body.emails).toHaveLength(1);
    expect(owner.tenantId).toBeTruthy();
  });

  it("serves a real PDF, stores it with its hash, and rebuilds it if the file is lost or tampered with", async () => {
    const { ctx, owner, api, won } = await setup();
    const { conversion } = await won();
    const res = await request(ctx.app).get(`/api/invoices/${conversion.invoiceId}/pdf`).set(bearer(owner.accessToken)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toContain("INV-00001.pdf");
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");

    const row = (await ownerPool().query("SELECT pdf_storage_key, pdf_sha256 FROM invoices WHERE id = $1", [conversion.invoiceId])).rows[0];
    expect(row.pdf_storage_key).toBe(`${owner.tenantId}/${conversion.invoiceId}.pdf`);
    expect(row.pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    const file = path.join(os.tmpdir(), "apex-test-invoices", row.pdf_storage_key);
    expect(existsSync(file)).toBe(true);

    await writeFile(file, "tampered");
    const again = await api().get(`/api/invoices/${conversion.invoiceId}/pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect((again.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("mark-paid and void need invoices:manage and follow the legal states", async () => {
    const { ctx, owner, api, won } = await setup();
    const member = await userWithRole(ctx, owner.accessToken, "MEMBER");
    const a = await won();
    const b = await won();
    expect((await api(member.accessToken).get(`/api/invoices/${a.conversion.invoiceId}`)).status).toBe(200);
    expect((await api(member.accessToken).post(`/api/invoices/${a.conversion.invoiceId}/mark-paid`)).status).toBe(403);
    const paid = await api().post(`/api/invoices/${a.conversion.invoiceId}/mark-paid`);
    expect(paid.body).toMatchObject({ status: "PAID" });
    expect(paid.body.paidAt).toBeTruthy();
    expect((await api().post(`/api/invoices/${a.conversion.invoiceId}/mark-paid`)).body.error.code).toBe("INVALID_INVOICE_STATE");
    expect((await api().post(`/api/invoices/${a.conversion.invoiceId}/void`, { reason: "oops" })).status).toBe(409);

    expect((await api().post(`/api/invoices/${b.conversion.invoiceId}/void`, {})).status).toBe(400);
    const voided = await api().post(`/api/invoices/${b.conversion.invoiceId}/void`, { reason: "Raised by mistake" });
    expect(voided.body.status).toBe("VOID");
    const mail = await ownerPool().query("SELECT status, last_error FROM email_outbox WHERE invoice_id = $1", [b.conversion.invoiceId]);
    expect(mail.rows[0]).toEqual({ status: "ABANDONED", last_error: "Invoice was voided" });
    expect((await api().post(`/api/invoices/${b.conversion.invoiceId}/resend`, {})).body.error.code).toBe("INVOICE_VOID");
  });

  it("resend queues a new e-mail only when none is already waiting", async () => {
    const { api, won } = await setup();
    const { conversion } = await won();
    const blocked = await api().post(`/api/invoices/${conversion.invoiceId}/resend`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("EMAIL_IN_PROGRESS");
    await ownerPool().query("UPDATE email_outbox SET status = 'SENT', sent_at = now() WHERE invoice_id = $1", [conversion.invoiceId]);
    const ok = await api().post(`/api/invoices/${conversion.invoiceId}/resend`, { to: "Other@Client.Example.com" });
    expect(ok.status).toBe(202);
    const rows = (await ownerPool().query("SELECT to_email, status, idempotency_key FROM email_outbox WHERE invoice_id = $1 ORDER BY created_at", [conversion.invoiceId])).rows;
    expect(rows.map((r) => r.status)).toEqual(["SENT", "PENDING"]);
    expect(rows[1].to_email).toBe("other@client.example.com");
    expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(2);
  });

  it("stats add up billed, outstanding, paid and overdue amounts", async () => {
    const { api, won } = await setup();
    const a = await won();
    await won({ items: [{ description: "x", quantity: 1, unitAmountMinor: 10_000, taxRateBp: 0 }] });
    await api().post(`/api/invoices/${a.conversion.invoiceId}/mark-paid`);
    const s = (await api().get("/api/invoices/stats")).body;
    expect(s.paidMinor).toBe(118_000);
    expect(s.outstandingMinor).toBe(10_000);
    expect(s.byStatus.PAID.count).toBe(1);
    expect(s.monthly).toHaveLength(6);
    expect(s.monthly[5]).toMatchObject({ billedMinor: 128_000, paidMinor: 118_000 });
  });
});

describe("clients API", () => {
  it("lists with search and invoice totals, shows detail, and edits without touching issued invoices", async () => {
    const { api, won } = await setup();
    const a = await won();
    await won();
    const list = await api().get("/api/clients?limit=10");
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0]).toMatchObject({ invoiceCount: 1, billedMinor: 118_000 });
    const t = (await api().get(`/api/clients/${a.conversion.clientId}`)).body.client;
    expect((await api().get(`/api/clients?q=${encodeURIComponent(t.name.toLowerCase())}`)).body.items.map((c: { id: string }) => c.id)).toEqual([a.conversion.clientId]);
    expect((await api().get("/api/clients?q=%25")).body.items).toEqual([]);

    const patched = await api().patch(`/api/clients/${a.conversion.clientId}`, { name: "Renamed Client", email: "New@Client.Example.com", billingAddress: { city: "Mumbai", line1: "" } });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: "Renamed Client", email: "new@client.example.com", billingAddress: { city: "Mumbai" } });
    const detail = await api().get(`/api/clients/${a.conversion.clientId}`);
    expect(detail.body.invoices).toHaveLength(1);
    const inv = await api().get(`/api/invoices/${a.conversion.invoiceId}`);
    expect(inv.body.client.name).toBe(t.name); // the invoice keeps what it was issued with
    expect((await api().patch(`/api/clients/${a.conversion.clientId}`, {})).status).toBe(400);
    expect((await api().patch(`/api/clients/${a.conversion.clientId}`, { leadId: randomUUID() })).status).toBe(400);
  });

  it("members can read but not edit clients", async () => {
    const { ctx, owner, api, won } = await setup();
    const member = await userWithRole(ctx, owner.accessToken, "MEMBER");
    const { conversion } = await won();
    expect((await api(member.accessToken).get(`/api/clients/${conversion.clientId}`)).status).toBe(200);
    expect((await api(member.accessToken).patch(`/api/clients/${conversion.clientId}`, { name: "Hax" })).status).toBe(403);
  });
});

describe("tenant isolation for billing", () => {
  it("another workspace cannot read, pay, void, resend, edit or download anything", async () => {
    const a = await setup("billA");
    const b = await setup("billB");
    const { conversion } = await a.won();
    const eb = b.api();
    for (const [method, url] of [
      ["get", `/api/invoices/${conversion.invoiceId}`], ["get", `/api/invoices/${conversion.invoiceId}/pdf`], ["get", `/api/clients/${conversion.clientId}`],
    ] as const) expect((await eb[method](url)).status, url).toBe(404);
    expect((await eb.post(`/api/invoices/${conversion.invoiceId}/mark-paid`)).status).toBe(404);
    expect((await eb.post(`/api/invoices/${conversion.invoiceId}/void`, { reason: "because" })).status).toBe(404);
    expect((await eb.post(`/api/invoices/${conversion.invoiceId}/resend`, {})).status).toBe(404);
    expect((await eb.patch(`/api/clients/${conversion.clientId}`, { name: "Hax" })).status).toBe(404);
    expect((await eb.get("/api/invoices")).body.items).toEqual([]);
    expect((await eb.get("/api/clients")).body.items).toEqual([]);
    expect((await eb.get("/api/emails")).body.items).toEqual([]);
    expect((await eb.get("/api/invoices/stats")).body.byStatus).toEqual({});
    // B's own numbering starts at 1 and does not see A's counter.
    expect((await b.win(await b.negotiating())).body.conversion.invoiceNumber).toBe("INV-00001");
    // The composite foreign keys also stop a cross-tenant invoice at the database level.
    await expectPgError(
      ownerPool().query(
        "INSERT INTO invoices (tenant_id, client_id, idempotency_key, number, status, subtotal_minor, total_minor) VALUES ($1, $2, 'x', 'X-1', 'ISSUED', 0, 0)",
        [b.owner.tenantId, conversion.clientId],
      ),
      "23503",
    );
  });
});

export type { TestCtx };
