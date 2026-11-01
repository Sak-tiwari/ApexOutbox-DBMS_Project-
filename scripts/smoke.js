#!/usr/bin/env node
/**
 * End-to-end smoke test against RUNNING processes (API + worker), used for release checks.
 *   API_URL=http://localhost:3000 API_KEY=... OWNER_ID=ownerA MONGODB_URI=mongodb://... node scripts/smoke.js
 * OWNER_ID must be the user id that API_KEY maps to in API_KEYS ("key:ownerA").
 * It creates one throwaway lead (Phase 3 has no create endpoint; Phase 2 ingestion will),
 * moves it to Closed-Won over HTTP, waits for the invoice email, then replays and checks nothing duplicates.
 */
const { MongoClient } = require("mongodb");
const fs = require("node:fs");

const { API_URL = "http://localhost:3000", API_KEY, OWNER_ID = "ownerA", MONGODB_URI } = process.env;
if (!API_KEY || !MONGODB_URI) { console.error("API_KEY and MONGODB_URI are required"); process.exit(2); }

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`); };
const api = async (method, path, body, key = API_KEY) => {
  const res = await fetch(API_URL + path, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const client = await MongoClient.connect(MONGODB_URI);
  const db = client.db();
  try {
    const ready = await api("GET", "/ready");
    check("API is ready (mongo + redis up)", ready.status === 200, JSON.stringify(ready.body?.checks));
    check("unauthenticated request is rejected", (await api("GET", "/api/leads/x", null, null)).status === 401);

    const { insertedId } = await db.collection("leads").insertOne({ name: "Smoke Lead", company: "Smoke Co", currentState: "New", ownerId: OWNER_ID, activityHistory: [], __v: 0, createdAt: new Date(), updatedAt: new Date() });
    const id = String(insertedId);
    const t = (targetState, version, extra = {}) => api("POST", `/api/leads/${id}/transition`, { targetState, version, ...extra });

    check("New -> Contacted", (await t("Contacted", 0)).status === 200);
    check("illegal jump is 422", (await t("Closed-Won", 1, { deal: { email: "s@example.com", amount: 1, description: "x" } })).status === 422);
    check("stale version is 409", (await t("Negotiation", 0)).status === 409);
    check("Contacted -> Negotiation", (await t("Negotiation", 1)).status === 200);
    check("Closed-Won without a deal is 400", (await t("Closed-Won", 2)).status === 400);

    const won = await t("Closed-Won", 2, { deal: { email: "smoke@example.com", amount: 4999.5, currency: "INR", description: "Smoke test invoice" } });
    check("Closed-Won accepted, onboarding DONE", won.status === 200 && won.body?.onboarding === "DONE", `status=${won.status} onboarding=${won.body?.onboarding}`);

    const invoices = db.collection("invoices");
    let inv = null;
    for (let i = 0; i < 60; i++) { inv = await invoices.findOne({ idempotencyKey: `lead:${id}:initial-invoice` }); if (inv && inv.status === "EMAIL_SENT") break; await sleep(500); }
    check("invoice reached EMAIL_SENT via outbox -> queue -> worker", inv?.status === "EMAIL_SENT", `status=${inv?.status}`);
    check("PDF exists and is a real PDF", !!inv?.pdfPath && fs.existsSync(inv.pdfPath) && fs.readFileSync(inv.pdfPath).subarray(0, 5).toString() === "%PDF-", inv?.pdfPath);
    check("exactly one email attempt recorded", inv?.emailAttempts === 1, `attempts=${inv?.emailAttempts}`);

    const replay = await t("Closed-Won", 2, { deal: { email: "smoke@example.com", amount: 4999.5, currency: "INR", description: "Smoke test invoice" } });
    check("replaying Closed-Won is rejected (409), not re-processed", replay.status === 409);
    await api("POST", "/api/phase4/onboard", { leadId: id, clientName: "Smoke Lead", email: "smoke@example.com", amount: 4999.5, description: "Smoke test invoice" });
    await sleep(1500);
    check("one client", (await db.collection("clients").countDocuments({ sourceLeadId: id })) === 1);
    check("one invoice", (await invoices.countDocuments({ idempotencyKey: `lead:${id}:initial-invoice` })) === 1);
    check("one outbox event", (await db.collection("outboxevents").countDocuments({ eventId: `invoice-created:${inv?._id}` })) === 1);
    check("still one email attempt after replays", (await invoices.findOne({ _id: inv?._id }))?.emailAttempts === 1);

    const metrics = await fetch(API_URL + "/metrics", { headers: { authorization: `Bearer ${API_KEY}` } });
    const text = await metrics.text();
    check("/metrics served with business gauges", metrics.status === 200 && text.includes("apexoutbox_outbox_pending"));
  } finally {
    await client.close();
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("smoke test crashed:", e); process.exit(1); });
