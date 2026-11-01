import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import IORedis from "ioredis";
import mongoose from "mongoose";
import request from "supertest";
import { Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { ConflictError } from "../../src/errors";
import { Metrics } from "../../src/metrics";
import { Lead } from "../../src/models/Lead";
import { Client, Invoice } from "../../src/phase4/models";
import { OutboxEvent } from "../../src/phase4/outbox";
import { dispatchOnce } from "../../src/phase4/dispatcherCore";
import { generateInvoicePDF } from "../../src/phase4/invoice";
import { MongoInvoiceStore, MongoOutboxStore } from "../../src/phase4/mongoStores";
import { onboardClient } from "../../src/phase4/onboardingService";
import { silentLog } from "../../src/phase4/ports";
import { processInvoiceJob } from "../../src/phase4/processor";
import { createQueueClient, QUEUE_NAME, type QueueClient } from "../../src/phase4/queue";
import { attemptOnboarding, reconcileOnboarding } from "../../src/services/onboardingHandoff";
import { TransitionService } from "../../src/services/TransitionService";
import { MongoLeadStore } from "../../src/stores/mongoLeadStore";
import { connectTestDb, dropAndDisconnect, mongoEngine } from "../helpers/mongo";
import { TestRedis } from "../helpers/redis";

const engine = await mongoEngine();
const available = engine !== "none";
// FerretDB (a MongoDB-compatible emulator) does not make concurrent conditional updates atomic: with the
// plain MongoDB driver and none of our code involved, 2 of 10 concurrent {_id, v:0} -> {$inc v} updates win.
// Real MongoDB guarantees single-document atomicity, so the tests that PROVE our locking and claiming only
// make sense there. They are skipped on FerretDB and must be run on real mongod (see docs/RUNBOOK.md).
const realMongo = engine === "mongodb";
const itAtomic = it.skipIf(!realMongo);
if (!available) console.warn("[mongo.test] No MongoDB reachable at TEST_MONGODB_URI (default mongodb://127.0.0.1:27017): ALL tests in this file are SKIPPED.");
else if (!realMongo) console.warn("[mongo.test] Engine is FerretDB, not real MongoDB: atomicity tests (marked itAtomic) are SKIPPED.");

const leads = new MongoLeadStore();
const svc = new TransitionService(leads);
const onboardInput = (leadId: string) => ({ leadId, clientName: "Asha", email: "asha@example.com", company: "Acme", amount: 5000, currency: "INR", description: "Website build" });
const deal = { email: "asha@example.com", amount: 5000, currency: "INR", description: "Website build" };
const newLead = async (extra: object = {}) => String((await Lead.create({ name: "Asha", company: "Acme", ownerId: "ownerA", ...extra }))._id);
const step = (id: string, to: any, version: number, extra: object = {}) => svc.transitionLead({ leadId: id, targetState: to, actorId: "ownerA", expectedVersion: version, ...extra });

describe.skipIf(!available)("MongoDB integration", () => {
  let redis: TestRedis;
  let queue: QueueClient;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-it-"));

  beforeAll(async () => {
    await connectTestDb("apexoutbox_it");
    await Promise.all([Lead.init(), Client.init(), Invoice.init(), OutboxEvent.init()]);
    redis = await TestRedis.create();
    await redis.start();
    queue = createQueueClient(redis.url);
  });
  afterAll(async () => {
    await queue?.close();
    await redis?.stop();
    await dropAndDisconnect();
  });

  describe("unique constraints and idempotency", () => {
    it("the database itself rejects a second client / invoice / event for the same key", async () => {
      await Client.create({ sourceLeadId: "u1", name: "A", email: "a@b.co" });
      await expect(Client.create({ sourceLeadId: "u1", name: "B", email: "b@b.co" })).rejects.toMatchObject({ code: 11000 });
      const clientId = new mongoose.Types.ObjectId();
      const inv = (n: string) => ({ idempotencyKey: "k1", invoiceNumber: n, clientId, snapshot: {} });
      await Invoice.create(inv("N1"));
      await expect(Invoice.create(inv("N2"))).rejects.toMatchObject({ code: 11000 });
      await OutboxEvent.create({ eventId: "ev1", eventType: "INVOICE_CREATED", aggregateId: "a", payload: {} });
      await expect(OutboxEvent.create({ eventId: "ev1", eventType: "INVOICE_CREATED", aggregateId: "a", payload: {} })).rejects.toMatchObject({ code: 11000 });
    });

    it("20 concurrent onboarding calls for one lead make exactly 1 client, 1 invoice, 1 outbox event", async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => onboardClient(onboardInput("lead-race"))));
      expect(new Set(results.map((r) => r.invoiceId)).size).toBe(1);
      expect(new Set(results.map((r) => r.clientId)).size).toBe(1);
      expect(await Client.countDocuments({ sourceLeadId: "lead-race" })).toBe(1);
      expect(await Invoice.countDocuments({ idempotencyKey: "lead:lead-race:initial-invoice" })).toBe(1);
      expect(await OutboxEvent.countDocuments({ eventId: `invoice-created:${results[0]!.invoiceId}` })).toBe(1);
    });

    it("different leads get different invoices", async () => {
      const [a, b] = await Promise.all([onboardClient(onboardInput("lead-x")), onboardClient(onboardInput("lead-y"))]);
      expect(a.invoiceId).not.toBe(b.invoiceId);
      expect(a.invoiceNumber).not.toBe(b.invoiceNumber);
    });
  });

  describe("pipeline concurrency (optimistic locking, real database)", () => {
    itAtomic("10 simultaneous transitions with the same version: exactly one wins", async () => {
      const id = await newLead();
      const outcomes = await Promise.all(Array.from({ length: 10 }, () => step(id, "Contacted", 0).then(() => "ok", (e) => (e instanceof ConflictError ? "conflict" : String(e)))));
      expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "conflict")).toHaveLength(9);
      const doc = await Lead.findById(id).lean();
      expect(doc!.__v).toBe(1);
      expect(doc!.activityHistory).toHaveLength(1);
    });

    it("the store's conditional update itself refuses a stale version or state (not just the service pre-check)", async () => {
      const id = await newLead();
      const entry = (from: any, to: any) => ({ fromState: from, toState: to, changedBy: "ownerA", reason: "t", timestamp: new Date() });
      const first = await leads.applyTransition({ id, expectedVersion: 0, from: "New", to: "Contacted", entry: entry("New", "Contacted") });
      expect(first?.version).toBe(1);
      // same version again -> stale
      expect(await leads.applyTransition({ id, expectedVersion: 0, from: "New", to: "Contacted", entry: entry("New", "Contacted") })).toBeNull();
      // right version but the lead is no longer in the state the caller saw
      expect(await leads.applyTransition({ id, expectedVersion: 1, from: "New", to: "Closed-Lost", entry: entry("New", "Closed-Lost") })).toBeNull();
      const doc = await Lead.findById(id).lean();
      expect([doc!.currentState, doc!.__v, doc!.activityHistory.length]).toEqual(["Contacted", 1, 1]);
    });

    it("walks the whole path and keeps one audit row per move", async () => {
      const id = await newLead();
      await step(id, "Contacted", 0); await step(id, "Follow-up", 1); await step(id, "Negotiation", 2);
      const lead = await leads.findById(id);
      expect(lead!.currentState).toBe("Negotiation");
      expect(lead!.activityHistory.map((a) => a.toState)).toEqual(["Contacted", "Follow-up", "Negotiation"]);
    });

    it("a malformed id is 'not found', not a database error", async () => {
      expect(await leads.findById("not-an-object-id")).toBeNull();
    });
  });

  describe("end to end: Closed-Won -> client + invoice -> outbox -> queue -> PDF -> email", () => {
    it("produces exactly one client, invoice, PDF and email, and replays change nothing", async () => {
      await OutboxEvent.deleteMany({}); // earlier tests leave deliberately odd events behind
      const sent: string[] = [];
      const sendEmail = async (d: { invoiceNumber: string; to: string }) => { sent.push(`${d.invoiceNumber}:${d.to}`); return { messageId: `<${d.invoiceNumber}@t>`, demo: false }; };
      const invoiceStore = new MongoInvoiceStore();
      const outboxStore = new MongoOutboxStore();

      // 1. Worker consuming the real BullMQ queue
      const workerConn = new IORedis(redis.url, { maxRetriesPerRequest: null });
      const done = new Map<string, () => void>();
      const worker = new Worker(QUEUE_NAME, async (job) => {
        const r = await processInvoiceJob(job.data.invoiceId, { store: invoiceStore, generatePdf: (n, s) => generateInvoicePDF(n, s, tmpDir), sendEmail, log: silentLog });
        return r;
      }, { connection: workerConn, concurrency: 2 });
      const completed = new Promise<void>((resolve) => worker.on("completed", () => resolve()));
      void done;

      try {
        // 2. Lead goes to Closed-Won through the API-level service, with its deal
        const id = await newLead();
        await step(id, "Contacted", 0); await step(id, "Negotiation", 1);
        const won = await step(id, "Closed-Won", 2, { deal });
        expect(won.onboardingStatus).toBe("PENDING");
        expect(won.deal).toMatchObject(deal);

        // 3. Hand-off creates client + invoice + outbox event
        expect(await attemptOnboarding(won, { leads, onboard: onboardClient, log: silentLog })).toBe("DONE");
        const invoice = (await Invoice.findOne({ idempotencyKey: `lead:${id}:initial-invoice` }))!;
        expect(invoice.status).toBe("PENDING");
        const eventId = `invoice-created:${invoice._id}`;
        expect((await OutboxEvent.findOne({ eventId }))!.status).toBe("PENDING");

        // 4. Dispatcher publishes to the real queue; the worker handles it
        expect(await dispatchOnce({ store: outboxStore, publishInvoiceJob: queue.enqueueInvoiceJob, log: silentLog })).toBe("published");
        await completed;

        const final = (await Invoice.findById(invoice._id))!;
        expect(final.status).toBe("EMAIL_SENT");
        expect(final.emailMessageId).toBe(`<${invoice.invoiceNumber}@t>`);
        expect(final.emailAttempts).toBe(1);
        expect(fs.readFileSync(final.pdfPath).subarray(0, 5).toString()).toBe("%PDF-");
        expect(sent).toEqual([`${invoice.invoiceNumber}:asha@example.com`]);
        expect((await OutboxEvent.findOne({ eventId }))!.status).toBe("PUBLISHED");

        // 5. REPLAYS: onboarding again, event re-published, job re-added, job re-processed directly
        await onboardClient(onboardInput(id));
        await reconcileOnboarding({ leads, onboard: onboardClient, log: silentLog });
        await OutboxEvent.updateOne({ eventId }, { $set: { status: "PENDING", attempts: 0 } });
        await dispatchOnce({ store: outboxStore, publishInvoiceJob: queue.enqueueInvoiceJob, log: silentLog });
        await queue.enqueueInvoiceJob(String(invoice._id));
        const again = await processInvoiceJob(String(invoice._id), { store: invoiceStore, generatePdf: (n, s) => generateInvoicePDF(n, s, tmpDir), sendEmail, log: silentLog });
        await new Promise((r) => setTimeout(r, 500));

        expect(again).toEqual({ outcome: "skipped", reason: "already-sent" });
        expect(sent).toHaveLength(1);
        expect(await Client.countDocuments({ sourceLeadId: id })).toBe(1);
        expect(await Invoice.countDocuments({ idempotencyKey: `lead:${id}:initial-invoice` })).toBe(1);
        expect(await OutboxEvent.countDocuments({ eventId })).toBe(1);
        expect(fs.readdirSync(tmpDir).filter((f) => f.startsWith(invoice.invoiceNumber))).toEqual([`${invoice.invoiceNumber}.pdf`]);
      } finally {
        await worker.close();
        workerConn.disconnect();
      }
    });
  });

  describe("failure recovery", () => {
    it("a Closed-Won lead whose onboarding failed is finished later by the reconciler", async () => {
      const id = await newLead();
      await step(id, "Contacted", 0); await step(id, "Negotiation", 1);
      const won = await step(id, "Closed-Won", 2, { deal });

      expect(await attemptOnboarding(won, { leads, onboard: async () => { throw new Error("db unavailable"); }, log: silentLog })).toBe("PENDING");
      expect(await Invoice.countDocuments({ idempotencyKey: `lead:${id}:initial-invoice` })).toBe(0);
      expect((await Lead.findById(id).lean())!.onboardingError).toMatch(/db unavailable/);

      const tally = await reconcileOnboarding({ leads, onboard: onboardClient, log: silentLog });
      expect(tally.done).toBeGreaterThanOrEqual(1);
      expect(await Invoice.countDocuments({ idempotencyKey: `lead:${id}:initial-invoice` })).toBe(1);
      expect((await Lead.findById(id).lean())!.onboardingStatus).toBe("DONE");
    });

    it("an outbox event abandoned in PROCESSING by a crashed dispatcher is picked up again", async () => {
      await OutboxEvent.deleteMany({});
      const r = await onboardClient(onboardInput("lead-crash"));
      const eventId = `invoice-created:${r.invoiceId}`;
      await OutboxEvent.collection.updateOne({ eventId }, { $set: { status: "PROCESSING", attempts: 1, updatedAt: new Date(Date.now() - 10 * 60_000) } });
      const published: string[] = [];
      let guard = 0;
      while ((await OutboxEvent.findOne({ eventId }))!.status !== "PUBLISHED" && guard++ < 10) {
        await dispatchOnce({ store: new MongoOutboxStore(), publishInvoiceJob: async (id) => { published.push(id); }, log: silentLog });
      }
      expect(published).toContain(r.invoiceId);
    });

    itAtomic("five concurrent processors for one invoice send exactly one email (real claim)", async () => {
      const r = await onboardClient(onboardInput("lead-parallel"));
      const sent: string[] = [];
      const deps = { store: new MongoInvoiceStore(), log: silentLog, generatePdf: (n: string, s: any) => generateInvoicePDF(n, s, tmpDir), sendEmail: async (d: any) => { await new Promise((x) => setTimeout(x, 100)); sent.push(d.invoiceNumber); return { messageId: "m", demo: false }; } };
      const results = await Promise.all(Array.from({ length: 5 }, () => processInvoiceJob(r.invoiceId, deps)));
      expect(sent).toHaveLength(1);
      expect(results.filter((x) => x.outcome === "sent")).toHaveLength(1);
      expect((await Invoice.findById(r.invoiceId))!.emailAttempts).toBe(1);
    });

    it("findStuck returns only old, unsent invoices (query used by the requeue sweep)", async () => {
      const store = new MongoInvoiceStore();
      const stuck = await onboardClient(onboardInput("lead-stuck"));
      const fresh = await onboardClient(onboardInput("lead-fresh"));
      const sent = await onboardClient(onboardInput("lead-sent-old"));
      const old = new Date(Date.now() - 60 * 60_000);
      await Invoice.collection.updateOne({ _id: new mongoose.Types.ObjectId(stuck.invoiceId) }, { $set: { updatedAt: old } });
      await Invoice.collection.updateOne({ _id: new mongoose.Types.ObjectId(sent.invoiceId) }, { $set: { updatedAt: old, status: "EMAIL_SENT" } });
      const ids = await store.findStuck(new Date(Date.now() - 10 * 60_000), 100);
      expect(ids).toContain(stuck.invoiceId);
      expect(ids).not.toContain(fresh.invoiceId);
      expect(ids).not.toContain(sent.invoiceId);
    });

    it("an email timeout leaves EMAIL_UNCERTAIN in the database and a replay does not resend", async () => {
      const { EmailUncertainError } = await import("../../src/phase4/email");
      const r = await onboardClient(onboardInput("lead-timeout"));
      let calls = 0;
      const deps = { store: new MongoInvoiceStore(), log: silentLog, generatePdf: (n: string, s: any) => generateInvoicePDF(n, s, tmpDir), sendEmail: async () => { calls++; throw new EmailUncertainError("socket timeout"); } };
      expect((await processInvoiceJob(r.invoiceId, deps)).outcome).toBe("uncertain");
      expect((await processInvoiceJob(r.invoiceId, deps)).outcome).toBe("skipped");
      expect(calls).toBe(1);
      expect((await Invoice.findById(r.invoiceId))!.status).toBe("EMAIL_UNCERTAIN");
    });
  });

  describe("HTTP API on the real database", () => {
    const KEY = "k".repeat(24);
    const app = () => createApp({ leads, transitions: svc, onboard: onboardClient, log: silentLog, metrics: new Metrics(), apiKeys: new Map([[KEY, "ownerA"]]), checks: { mongo: () => true, redis: () => true } });
    const auth = { Authorization: `Bearer ${KEY}` };

    it("lists leads with filters and validates dates", async () => {
      await Lead.create({ name: "Filtered", company: "F", ownerId: "ownerFilter", followUpDate: new Date("2026-03-01") });
      const res = await request(app()).get("/api/leads").query({ ownerId: "ownerFilter", followUpBefore: "2026-04-01" }).set(auth);
      expect(res.status).toBe(200);
      expect(res.body.data.map((l: any) => l.name)).toEqual(["Filtered"]);
      expect(res.body.data[0].activityHistory).toBeUndefined();
      expect((await request(app()).get("/api/leads").query({ followUpBefore: "not-a-date" }).set(auth)).status).toBe(400);
    });

    it("full Closed-Won over HTTP creates the client and invoice", async () => {
      const id = await newLead();
      const post = (body: object) => request(app()).post(`/api/leads/${id}/transition`).set(auth).send(body);
      expect((await post({ targetState: "Contacted", version: 0 })).status).toBe(200);
      expect((await post({ targetState: "Negotiation", version: 1 })).status).toBe(200);
      const won = await post({ targetState: "Closed-Won", version: 2, deal });
      expect(won.status).toBe(200);
      expect(won.body.onboarding).toBe("DONE");
      expect(await Invoice.countDocuments({ idempotencyKey: `lead:${id}:initial-invoice` })).toBe(1);
      expect((await request(app()).get(`/api/leads/${id}`).set(auth)).body.data.activityHistory).toHaveLength(3);
      expect((await request(app()).get("/api/leads/not-an-id").set(auth)).status).toBe(404);
    });
  });
});
