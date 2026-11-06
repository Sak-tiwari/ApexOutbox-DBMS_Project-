import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { builtinVersionId } from "../../src/invoiceTemplates/builtins";
import { MongoInvoiceAccess } from "../../src/invoiceTemplates/invoiceAccess";
import { generateInvoicePdfWithTemplate } from "../../src/invoiceTemplates/invoicePdf";
import { BusinessProfile, InvoiceTemplate, InvoiceTemplateVersion, TemplateAsset } from "../../src/invoiceTemplates/models";
import { closeRenderer } from "../../src/invoiceTemplates/renderer";
import { InvoiceTemplateStore } from "../../src/invoiceTemplates/store";
import { Lead } from "../../src/models/Lead";
import { Metrics } from "../../src/metrics";
import { Client, Invoice } from "../../src/phase4/models";
import { MongoInvoiceStore } from "../../src/phase4/mongoStores";
import { onboardClient } from "../../src/phase4/onboardingService";
import { silentLog } from "../../src/phase4/ports";
import { processInvoiceJob } from "../../src/phase4/processor";
import { TransitionService } from "../../src/services/TransitionService";
import { MongoLeadStore } from "../../src/stores/mongoLeadStore";
import { connectTestDb, dropAndDisconnect, mongoEngine } from "../helpers/mongo";
import { requireOrWarn } from "../helpers/require";

const engine = await mongoEngine();
requireOrWarn("invoice-templates.test", engine !== "none", "no MongoDB-compatible server is reachable at TEST_MONGODB_URI");
let chromiumOk = true;
try { fs.accessSync(require("playwright-core").chromium.executablePath()); } catch { chromiumOk = false; }
const textOf = (file: string) => execFileSync("pdftotext", [file, "-"]).toString();

const KEY_A = "a".repeat(24), KEY_B = "b".repeat(24);
const A = { Authorization: `Bearer ${KEY_A}` }, B = { Authorization: `Bearer ${KEY_B}` };
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a70000000049454e44ae426082", "hex");
const b64 = (b: Buffer) => b.toString("base64");

const TEMPLATE = (marker: string) => `<!doctype html><html><body>
<img src="asset:logo.png" alt="logo"><h1>${marker}</h1>
<p>No. {{invoice.number}} for {{client.name}} ({{client.gstin}}) from {{business.name}} GSTIN {{business.gstin}}</p>
<table><tbody>{{#each items}}<tr><td>{{description}}</td><td>{{amount}}</td></tr>{{/each}}</tbody></table>
{{#if tax.is_inter}}<p>IGST {{tax.igst_rate}} {{totals.igst}}</p>{{/if}}{{#if tax.is_intra}}<p>CGST {{totals.cgst}} SGST {{totals.sgst}}</p>{{/if}}
<p>TOTAL {{totals.total}}</p><p>{{totals.amount_in_words}}</p>
<script>document.body.innerHTML = "HACKED"</script><img src="{{business.logo}}" onerror="alert(1)"><a href="javascript:alert(1)">pay</a>
</body></html>`;

describe.skipIf(engine === "none" || !chromiumOk)("Invoice Templates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-tpl-"));
  const store = new InvoiceTemplateStore(path.join(dir, "assets"));
  const access = new MongoInvoiceAccess({ store, invoiceDir: dir, log: silentLog });
  const leads = new MongoLeadStore();
  let app: ReturnType<typeof createApp>;
  let templateId = "";
  let firstInvoiceId = "";

  const pdfFor = async (invoiceId: string) => {
    const inv: any = await Invoice.findById(invoiceId).lean();
    const r = await generateInvoicePdfWithTemplate(inv.invoiceNumber, inv.snapshot, { store, invoiceDir: dir, log: silentLog });
    return { ...r, text: textOf(r.path) };
  };
  /** Creates a lead for the user and closes it with the given deal; returns the invoice id. */
  const closeDeal = async (h: Record<string, string>, deal: Record<string, unknown>, expectStatus = 200) => {
    const lead = (await request(app).post("/api/leads").set(h).send({ name: "Ravi Kumar", company: "Kumar & Sons" })).body.data;
    let v = lead.version;
    for (const s of ["Contacted", "Negotiation"]) v = (await request(app).post(`/api/leads/${lead.id}/transition`).set(h).send({ targetState: s, version: v })).body.data.version;
    const won = await request(app).post(`/api/leads/${lead.id}/transition`).set(h).send({ targetState: "Closed-Won", version: v, deal: { email: "ravi@kumar.test", amount: 50000, currency: "INR", description: "Website build", ...deal } });
    expect(won.status, JSON.stringify(won.body)).toBe(expectStatus);
    if (expectStatus !== 200) return "";
    const inv: any = await Invoice.findOne({ idempotencyKey: `lead:${lead.id}:initial-invoice` }).lean();
    return String(inv._id);
  };

  beforeAll(async () => {
    await connectTestDb("apex_tpl");
    await Promise.all([Invoice.init(), Client.init(), Lead.init(), InvoiceTemplate.init(), InvoiceTemplateVersion.init(), TemplateAsset.init(), BusinessProfile.init()]);
    app = createApp({
      leads, transitions: new TransitionService(leads), onboard: onboardClient, log: silentLog, metrics: new Metrics(),
      apiKeys: new Map([[KEY_A, "ownerA"], [KEY_B, "ownerB"]]), checks: { mongo: () => true, redis: () => true },
      invoiceTemplates: { store, invoices: access },
      invoiceNumberTaken: async (o, n) => !!(await Invoice.exists({ ownerId: o, displayNumber: n })),
    });
  });
  afterAll(async () => { await closeRenderer(); await dropAndDisconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

  describe("library and business details", () => {
    it("lists the four built-ins with Standard as default; built-ins cannot be edited or deleted", async () => {
      const list = (await request(app).get("/api/invoice-templates").set(A)).body.data;
      expect(list.map((t: any) => t.id)).toEqual(["builtin:technolites", "builtin:standard", "builtin:minimal", "builtin:corporate", "builtin:gst"]);
      expect(list.filter((t: any) => t.isDefault).map((t: any) => t.id)).toEqual(["builtin:technolites"]);
      expect((await request(app).delete("/api/invoice-templates/builtin:standard").set(A)).status).toBe(409);
      expect((await request(app).put("/api/invoice-templates/builtin:gst").set(A).send({ source: "x" })).status).toBe(409);
    });
    it("placeholder reference and the example template download", async () => {
      const p = (await request(app).get("/api/invoice-templates/placeholders").set(A)).body.data;
      expect(p.groups.map((g: any) => g.group)).toEqual(expect.arrayContaining(["Business", "Client", "Invoice", "Totals", "Payment"]));
      expect(p.required).toEqual(["invoice.number", "client.name", "totals.total"]);
      const ex = await request(app).get("/api/invoice-templates/example").set(A);
      expect(ex.headers["content-disposition"]).toMatch(/attachment/);
      expect(ex.text).toContain("{{totals.amount_in_words}}");
    });
    it("business details are validated and saved per user", async () => {
      expect((await request(app).put("/api/invoice-templates/business").set(A).send({ gstin: "BADGSTIN" })).status).toBe(400);
      expect((await request(app).put("/api/invoice-templates/business").set(A).send({ ifsc: "123" })).status).toBe(400);
      expect((await request(app).put("/api/invoice-templates/business").set(A).send({ defaultGstRate: 7 })).status).toBe(400);
      expect((await request(app).put("/api/invoice-templates/business").set(A).send({ surprise: 1 })).status).toBe(400);
      const ok = await request(app).put("/api/invoice-templates/business").set(A).send({ name: "Apex Web Studio", gstin: "27abcde1234f1z5", state: "Maharashtra", defaultGstRate: 18, upiId: "apex@hdfc", bankName: "HDFC", account: "50100123456789", ifsc: "hdfc0001234" });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ gstin: "27ABCDE1234F1Z5", ifsc: "HDFC0001234", defaultGstRate: 18 });
      expect((await request(app).get("/api/invoice-templates/business").set(B)).body.data.name).toBe("");
    });
  });

  describe("assets", () => {
    it("accepts a real PNG and refuses wrong types, fakes, scripted SVGs and big files", async () => {
      const up = await request(app).post("/api/invoice-templates/assets").set(A).send({ name: "logo.png", dataBase64: b64(PNG) });
      expect(up.status).toBe(201);
      expect((await request(app).post("/api/invoice-templates/assets").set(A).send({ name: "run.exe", dataBase64: b64(Buffer.from("MZ")) })).status).toBe(415);
      expect((await request(app).post("/api/invoice-templates/assets").set(A).send({ name: "fake.png", dataBase64: b64(Buffer.from("<html>")) })).status).toBe(415);
      expect((await request(app).post("/api/invoice-templates/assets").set(A).send({ name: "x.svg", dataBase64: b64(Buffer.from('<svg onload="alert(1)"></svg>')) })).status).toBe(415);
      expect((await request(app).post("/api/invoice-templates/assets").set(A).send({ name: "big.png", dataBase64: b64(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])) })).status).toBe(413);
      const id = up.body.data.id;
      expect((await request(app).get(`/api/invoice-templates/assets/${id}`).set(A)).body.data.dataUri).toMatch(/^data:image\/png;base64,/);
      expect((await request(app).get(`/api/invoice-templates/assets/${id}`).set(B)).status).toBe(404);
      expect((await request(app).put("/api/invoice-templates/business").set(B).send({ logoAssetId: id })).status).toBe(400);
      expect((await request(app).put("/api/invoice-templates/business").set(A).send({ logoAssetId: id })).status).toBe(200);
    });
  });

  describe("uploading an HTML template", () => {
    it("rejects unknown placeholders and missing required fields with the full list", async () => {
      const bad = await request(app).post("/api/invoice-templates").set(A).send({ type: "html", name: "Bad", source: "<p>{{client.nmae}}</p>" });
      expect(bad.status).toBe(400);
      expect(bad.body.details.map((i: any) => i.message).join(" ")).toMatch(/client\.nmae.*invoice\.number|invoice\.number.*client\.nmae/s);
    });
    it("saves it sanitised: script, onerror and javascript: are gone", async () => {
      const res = await request(app).post("/api/invoice-templates").set(A).send({ type: "html", name: "Acme", source: TEMPLATE("ACME TEMPLATE V1") });
      expect(res.status).toBe(201);
      expect(res.body.issues.some((i: any) => i.level === "warning")).toBe(true);
      templateId = res.body.data.id;
      const saved = (await request(app).get(`/api/invoice-templates/${templateId}`).set(A)).body.data;
      expect(saved.version.source).not.toMatch(/<script|onerror|javascript:/i);
      expect(saved.version.source).toContain("{{#each items}}");
      expect(saved.currentVersion).toBe(1);
    });
    it("previews as HTML and as the exact PDF, with sample data", async () => {
      const html = await request(app).post(`/api/invoice-templates/${templateId}/preview`).set(A).send({ format: "html" });
      expect(html.body.data.html).toContain("ACME TEMPLATE V1");
      expect(html.body.data.html).toContain("Greenleaf Organics");
      expect(html.body.data.html).toContain("Apex Web Studio"); // the user's own business name
      expect(html.body.data.html).toMatch(/src="data:image\/png;base64,/); // asset:logo.png became a data URI
      const pdf = await request(app).post(`/api/invoice-templates/${templateId}/preview`).set(A).send({ format: "pdf" }).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on("data", (d: Buffer) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
      expect(pdf.headers["content-type"]).toBe("application/pdf");
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    });
    it("previews unsaved editor contents without saving, and refuses invalid drafts", async () => {
      const r = await request(app).post("/api/invoice-templates/new/preview").set(A).send({ source: "<b>DRAFT</b> {{invoice.number}} {{client.name}} {{totals.total}}" });
      expect(r.body.data.html).toContain("DRAFT");
      expect((await request(app).post("/api/invoice-templates/new/preview").set(A).send({ source: "{{nope}}" })).status).toBe(400);
      expect((await InvoiceTemplate.countDocuments({ ownerId: "ownerA" }))).toBe(1);
    });
  });

  describe("default template and new invoices", () => {
    it("only one default per user: setting another one moves the pointer", async () => {
      await request(app).post("/api/invoice-templates/builtin:gst/default").set(A).expect(200);
      await request(app).post(`/api/invoice-templates/${templateId}/default`).set(A).expect(200);
      const list = (await request(app).get("/api/invoice-templates").set(A)).body.data;
      expect(list.filter((t: any) => t.isDefault).map((t: any) => t.id)).toEqual([templateId]);
      expect(await BusinessProfile.countDocuments({ ownerId: "ownerA" })).toBe(1);
      await expect(BusinessProfile.create({ ownerId: "ownerA" })).rejects.toMatchObject({ code: 11000 }); // the database enforces it
    });
    it("closing a deal makes an invoice with the typed number and GSTIN, IGST across states, using the default template", async () => {
      firstInvoiceId = await closeDeal(A, { invoiceNumber: "INV/2026/001", businessGstin: "27ABCDE1234F1Z5", clientGstin: "07PQRSX6789K1Z2", clientAddress: "Delhi office", gstRate: 18 });
      const inv: any = await Invoice.findById(firstInvoiceId).lean();
      const t = (await request(app).get(`/api/invoice-templates/${templateId}`).set(A)).body.data;
      expect(inv).toMatchObject({ ownerId: "ownerA", displayNumber: "INV/2026/001" });
      expect(inv.snapshot.templateVersionId).toBe(t.currentVersionId);
      expect(inv.snapshot.totals).toMatchObject({ subtotal: 50000, igst: 9000, cgst: 0, total: 59000, mode: "inter" });
      expect(inv.snapshot.amount).toBe(59000);
      const pdf = await pdfFor(firstInvoiceId);
      expect(pdf.fallback).toBe(false);
      for (const s of ["ACME TEMPLATE V1", "INV/2026/001", "07PQRSX6789K1Z2", "27ABCDE1234F1Z5", "IGST 18%", "59,000.00", "Fifty Nine Thousand Rupees Only"]) expect(pdf.text).toContain(s);
      expect(pdf.text).not.toContain("HACKED");
    });
    it("the worker's job uses the template and emails it with the printed number", async () => {
      const sent: any[] = [];
      const r = await processInvoiceJob(firstInvoiceId, {
        store: new MongoInvoiceStore(), log: silentLog,
        generatePdf: async (n, s) => (await generateInvoicePdfWithTemplate(n, s, { store, invoiceDir: dir, log: silentLog })).path,
        sendEmail: async (d) => { sent.push(d); return { messageId: "m1", demo: true }; },
      });
      expect(r.outcome).toBe("sent");
      expect(sent[0]).toMatchObject({ displayNumber: "INV/2026/001", to: "ravi@kumar.test" });
      expect(textOf(sent[0].pdfPath)).toContain("ACME TEMPLATE V1");
    });
    it("the same invoice number cannot be used twice by one user (another user may use it)", async () => {
      await closeDeal(A, { invoiceNumber: "INV/2026/001" }, 409);
      await expect(Invoice.create({ idempotencyKey: "x", invoiceNumber: "INV-zz", clientId: (await Client.findOne().lean<any>())._id, snapshot: {}, ownerId: "ownerA", displayNumber: "INV/2026/001" })).rejects.toMatchObject({ code: 11000 });
      expect(await closeDeal(B, { invoiceNumber: "INV/2026/001" })).toBeTruthy();
    });
    it("same state gives CGST + SGST; no number typed = automatic number; bad GSTIN is refused", async () => {
      const id = await closeDeal(A, { clientGstin: "27PQRSX6789K1Z2", gstRate: 18 });
      const inv: any = await Invoice.findById(id).lean();
      expect(inv.snapshot.totals).toMatchObject({ cgst: 4500, sgst: 4500, igst: 0, total: 59000, mode: "intra" });
      expect(inv.displayNumber).toMatch(/^INV-[a-f0-9]{24}$/);
      await closeDeal(A, { businessGstin: "NOTAGSTIN" }, 400);
    });
  });

  describe("versions: editing never changes invoices already sent", () => {
    it("saving creates version 2; the old invoice still renders with version 1, new invoices use version 2", async () => {
      const r = await request(app).put(`/api/invoice-templates/${templateId}`).set(A).send({ source: TEMPLATE("ACME TEMPLATE V2") });
      expect(r.status).toBe(200);
      expect(r.body.data.currentVersion).toBe(2);
      expect((await pdfFor(firstInvoiceId)).text).toContain("ACME TEMPLATE V1");
      const newer = await closeDeal(A, {});
      expect((await pdfFor(newer)).text).toContain("ACME TEMPLATE V2");
    });
    it("history lists every version; rolling back copies v1 forward as v3", async () => {
      const v = (await request(app).get(`/api/invoice-templates/${templateId}/versions`).set(A)).body.data;
      expect(v.map((x: any) => x.version)).toEqual([2, 1]);
      const rb = await request(app).post(`/api/invoice-templates/${templateId}/rollback`).set(A).send({ version: 1 });
      expect(rb.body.data.currentVersion).toBe(3);
      expect((await request(app).get(`/api/invoice-templates/${templateId}`).set(A)).body.data.version.source).toContain("ACME TEMPLATE V1");
      expect(await InvoiceTemplateVersion.countDocuments({ templateId })).toBe(3);
    });
    it("regenerating an old invoice with a different template is explicit and recorded", async () => {
      const r = await request(app).post(`/api/invoice-templates/invoices/${firstInvoiceId}/regenerate`).set(A).send({ templateId: "builtin:gst" });
      expect(r.status).toBe(200);
      expect(r.body.data.usedVersionId).toBe(builtinVersionId("builtin:gst"));
      expect(textOf(((await Invoice.findById(firstInvoiceId).lean()) as any).pdfPath)).toContain("TAX INVOICE");
    });
    it("rename, duplicate and download source", async () => {
      await request(app).put(`/api/invoice-templates/${templateId}`).set(A).send({ name: "Acme Renamed" }).expect(200);
      const dup = await request(app).post(`/api/invoice-templates/${templateId}/duplicate`).set(A);
      expect(dup.body.data).toMatchObject({ name: "Acme Renamed (copy)", currentVersion: 1, isDefault: false });
      const dl = await request(app).get(`/api/invoice-templates/${templateId}/download`).set(A);
      expect(dl.headers["content-disposition"]).toMatch(/Acme-Renamed\.html/);
      const b = await request(app).post("/api/invoice-templates/builtin:minimal/duplicate").set(A);
      expect(b.status).toBe(201);
    });
  });

  describe("tenant isolation", () => {
    it("user B never sees or uses user A's templates, assets or invoices", async () => {
      const listB = (await request(app).get("/api/invoice-templates").set(B)).body.data;
      expect(listB.every((t: any) => t.builtin)).toBe(true);
      for (const [m, p, body] of [
        ["get", `/${templateId}`, undefined], ["put", `/${templateId}`, { name: "x" }], ["delete", `/${templateId}`, undefined],
        ["post", `/${templateId}/default`, {}], ["post", `/${templateId}/duplicate`, {}], ["get", `/${templateId}/versions`, undefined],
        ["post", `/${templateId}/rollback`, { version: 1 }], ["get", `/${templateId}/download`, undefined], ["post", `/${templateId}/preview`, {}],
        ["post", `/builtin:standard/preview`, { invoiceId: firstInvoiceId }], ["post", `/invoices/${firstInvoiceId}/regenerate`, {}],
      ] as const) {
        const res = await (request(app) as any)[m](`/api/invoice-templates${p}`).set(B).send(body);
        expect(res.status, `${m} ${p}`).toBe(404);
      }
      // A deal of B's naming A's template quietly uses B's own default instead
      const id = await closeDeal(B, { templateId });
      expect(((await Invoice.findById(id).lean()) as any).snapshot.templateVersionId).toBe(builtinVersionId("builtin:technolites"));
      // and a version id can never be rendered for another owner
      const t: any = await InvoiceTemplate.findById(templateId).lean();
      await expect(store.renderable(t.currentVersionId, "ownerB")).rejects.toThrow();
      expect((await request(app).get("/api/invoice-templates/invoices/mine").set(B)).body.data.every((i: any) => i.id !== firstInvoiceId)).toBe(true);
    });
  });

  describe("a broken template never stops an invoice", () => {
    it("a template that fails to render falls back to the built-in template (and logs a warning)", async () => {
      const badT = await InvoiceTemplate.create({ ownerId: "ownerA", name: "Broken", type: "html", currentVersionId: "x", currentVersion: 1 });
      const badV = await InvoiceTemplateVersion.create({ templateId: String(badT._id), ownerId: "ownerA", version: 1, source: "{{#if client.name}}never closed", createdBy: "ownerA" });
      const warnings: string[] = [];
      const log = { ...silentLog, warn: (_o: object, m: string) => { warnings.push(m); } };
      const inv: any = await Invoice.findById(firstInvoiceId).lean();
      const r = await generateInvoicePdfWithTemplate("INV-broken1", { ...inv.snapshot, templateVersionId: String(badV._id) }, { store, invoiceDir: dir, log });
      expect(r).toMatchObject({ fallback: true, usedVersionId: builtinVersionId("builtin:standard") });
      expect(textOf(r.path)).toContain("INV/2026/001");
      expect(warnings[0]).toMatch(/template failed/);
    });
    it("if Chromium itself fails, the basic PDF is still made", async () => {
      const inv: any = await Invoice.findById(firstInvoiceId).lean();
      const r = await generateInvoicePdfWithTemplate("INV-nochrome", inv.snapshot, { store, invoiceDir: dir, log: silentLog, toPdf: async () => { throw new Error("no chromium"); } });
      expect(r).toMatchObject({ fallback: true, usedVersionId: "legacy" });
      expect(textOf(r.path)).toContain("INV/2026/001");
    });
    it("invoices made before templates keep their original design", async () => {
      const r = await generateInvoicePdfWithTemplate("INV-old", { clientName: "Old Co", email: "o@x.test", company: "", amount: 100, currency: "INR", description: "Old work", createdAt: new Date() }, { store, invoiceDir: dir, log: silentLog });
      expect(r.usedVersionId).toBe("legacy");
      expect(textOf(r.path)).toContain("Old Co");
    });
  });

  describe("builder and DOCX", () => {
    it("the quick builder makes a template from options (colour, font, columns, overrides)", async () => {
      const builder = { layout: "builtin:corporate", color: "#0f766e", font: "serif", showLogo: false, columns: { qty: false, rate: true, tax: true }, footer: "BUILT WITH BUILDER", terms: "Pay in 7 days", overrides: { name: "Builder Biz" } };
      const r = await request(app).post("/api/invoice-templates").set(A).send({ type: "builder", name: "My builder", builder });
      expect(r.status).toBe(201);
      const prev = (await request(app).post(`/api/invoice-templates/${r.body.data.id}/preview`).set(A).send({})).body.data.html;
      for (const s of ["#0f766e", "Georgia", "BUILT WITH BUILDER", "Pay in 7 days", "Builder Biz"]) expect(prev).toContain(s);
      expect(prev).not.toMatch(/>Qty</);
      expect((await request(app).post("/api/invoice-templates").set(A).send({ type: "builder", name: "x", builder: { ...builder, color: "red" } })).status).toBe(400);
      expect((await request(app).put(`/api/invoice-templates/${r.body.data.id}`).set(A).send({ builder: { ...builder, footer: "V2" } })).body.data.currentVersion).toBe(2);
    });
    it("a macro-enabled DOCX upload is refused", async () => {
      const JSZip = (await import("jszip")).default;
      const z = new JSZip(); z.file("[Content_Types].xml", "<Types/>"); z.file("word/document.xml", "<w:document/>"); z.file("word/vbaProject.bin", "x");
      const r = await request(app).post("/api/invoice-templates").set(A).send({ type: "docx", name: "Macro", fileBase64: b64(await z.generateAsync({ type: "nodebuffer" })) });
      expect(r.status).toBe(415);
    });
  });

  it("a legacy profile that stored Standard (never chose a default) still gets Technolites", async () => {
    await BusinessProfile.updateOne({ ownerId: "legacy-user" }, { $set: { defaultTemplateId: "builtin:standard" } }, { upsert: true });
    const ver = await store.resolveVersionId("legacy-user");
    expect(ver).toBe(builtinVersionId("builtin:technolites"));
    await store.setDefault("legacy-user", "builtin:standard");
    expect(await store.resolveVersionId("legacy-user")).toBe(builtinVersionId("builtin:standard"));
  });

  it("deleting the default template makes the built-in Technolites template the default again; old invoices still render", async () => {
    await request(app).delete(`/api/invoice-templates/${templateId}`).set(A).expect(200);
    expect((await request(app).get("/api/invoice-templates").set(A)).body.data.find((t: any) => t.isDefault).id).toBe("builtin:technolites");
    const inv: any = await Invoice.findById(firstInvoiceId).lean();
    expect(inv.snapshot.templateVersionId).toBe(builtinVersionId("builtin:gst")); // regenerated earlier
    const anyV1: any = await InvoiceTemplateVersion.findOne({ templateId, version: 1 }).lean();
    expect(anyV1).toBeTruthy(); // versions are kept for old invoices
  });
});
