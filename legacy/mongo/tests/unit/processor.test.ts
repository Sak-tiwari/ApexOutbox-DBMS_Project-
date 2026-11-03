import { describe, expect, it } from "vitest";
import { EmailUncertainError } from "../../src/phase4/email";
import { InvoiceNotFoundError, processInvoiceJob, type ProcessorDeps } from "../../src/phase4/processor";
import { silentLog } from "../../src/phase4/ports";
import { MemoryInvoiceStore } from "../helpers/memory";

function setup(sendImpl?: ProcessorDeps["sendEmail"]) {
  const store = new MemoryInvoiceStore();
  store.seed({ id: "i1" });
  const sent: string[] = [];
  let pdfCalls = 0;
  const deps: ProcessorDeps = {
    store,
    log: silentLog,
    generatePdf: async (n) => { pdfCalls++; return `/pdf/${n}.pdf`; },
    sendEmail: sendImpl ?? (async (d) => { sent.push(d.invoiceNumber); return { messageId: `<${d.invoiceNumber}@t>`, demo: false }; }),
  };
  return { store, deps, sent, pdfCalls: () => pdfCalls };
}

describe("invoice processor", () => {
  it("makes the PDF, sends one email, records the message id", async () => {
    const { store, deps, sent } = setup();
    const r = await processInvoiceJob("i1", deps);
    expect(r.outcome).toBe("sent");
    expect(sent).toEqual(["INV-i1"]);
    const inv = store.invoices.get("i1")!;
    expect(inv.status).toBe("EMAIL_SENT");
    expect(inv.emailMessageId).toBe("<INV-i1@t>");
    expect(inv.pdfPath).toBe("/pdf/INV-i1.pdf");
  });

  it("replaying the same job does nothing (duplicate processing)", async () => {
    const { deps, sent } = setup();
    await processInvoiceJob("i1", deps);
    const again = await processInvoiceJob("i1", deps);
    expect(again).toEqual({ outcome: "skipped", reason: "already-sent" });
    expect(sent).toHaveLength(1);
  });

  it("five concurrent jobs for one invoice send exactly one email", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sent: string[] = [];
    const { deps } = setup(async (d) => { await gate; sent.push(d.invoiceNumber); return { messageId: "m", demo: false }; });
    const runs = Array.from({ length: 5 }, () => processInvoiceJob("i1", deps));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await Promise.all(runs);
    expect(sent).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "sent")).toHaveLength(1);
  });

  it("an email timeout becomes EMAIL_UNCERTAIN, is NOT thrown (no automatic retry) and is never resent", async () => {
    let calls = 0;
    const { store, deps } = setup(async () => { calls++; throw new EmailUncertainError("timeout"); });
    const r = await processInvoiceJob("i1", deps);
    expect(r.outcome).toBe("uncertain");
    expect(store.invoices.get("i1")!.status).toBe("EMAIL_UNCERTAIN");
    const again = await processInvoiceJob("i1", deps);
    expect(again).toEqual({ outcome: "skipped", reason: "uncertain-needs-manual-check" });
    expect(calls).toBe(1);
  });

  it("a definite failure is rethrown for retry, leaves EMAIL_FAILED, and the retry sends once", async () => {
    let calls = 0;
    const { store, deps } = setup(async (d) => { calls++; if (calls === 1) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); return { messageId: "ok", demo: false }; });
    await expect(processInvoiceJob("i1", deps)).rejects.toThrow("refused");
    expect(store.invoices.get("i1")!.status).toBe("EMAIL_FAILED");
    expect(store.invoices.get("i1")!.lastError).toMatch(/refused/);
    const r = await processInvoiceJob("i1", deps);
    expect(r.outcome).toBe("sent");
    expect(calls).toBe(2);
    expect(store.invoices.get("i1")!.emailAttempts).toBe(2);
  });

  it("crash after sending but before saving: the retry does NOT resend", async () => {
    const { store, deps, sent } = setup();
    // Simulate the worker dying right after the provider accepted the mail: claimed, never marked sent.
    await store.setPdf("i1", "/pdf/x.pdf");
    await store.claimForSending("i1");
    store.invoices.get("i1")!.updatedAt = new Date(Date.now() - 10 * 60_000);
    const r = await processInvoiceJob("i1", deps);
    expect(r.outcome).toBe("uncertain");
    expect(sent).toHaveLength(0);
    expect(store.invoices.get("i1")!.status).toBe("EMAIL_UNCERTAIN");
  });

  it("a fresh EMAIL_SENDING marker means another worker is mid-send: skip, do not touch", async () => {
    const { store, deps, sent } = setup();
    await store.setPdf("i1", "/pdf/x.pdf");
    await store.claimForSending("i1");
    const r = await processInvoiceJob("i1", deps);
    expect(r).toEqual({ outcome: "skipped", reason: "in-progress" });
    expect(store.invoices.get("i1")!.status).toBe("EMAIL_SENDING");
    expect(sent).toHaveLength(0);
  });

  it("reuses an existing PDF instead of regenerating it", async () => {
    const { store, deps, pdfCalls } = setup();
    store.invoices.get("i1")!.pdfPath = "/pdf/existing.pdf";
    store.invoices.get("i1")!.status = "PDF_READY";
    await processInvoiceJob("i1", deps);
    expect(pdfCalls()).toBe(0);
  });

  it("a missing invoice is a distinct, non-retryable error type", async () => {
    const { deps } = setup();
    await expect(processInvoiceJob("nope", deps)).rejects.toBeInstanceOf(InvoiceNotFoundError);
  });

  it("a PDF failure leaves the invoice unsent and rethrows for retry", async () => {
    const { store, deps, sent } = setup();
    deps.generatePdf = async () => { throw new Error("disk full"); };
    await expect(processInvoiceJob("i1", deps)).rejects.toThrow("disk full");
    expect(sent).toHaveLength(0);
    expect(store.invoices.get("i1")!.status).toBe("PENDING");
  });
});

import { EmailPermanentError, isPermanentSmtpError } from "../../src/phase4/email";

describe("invoice processor: recovery and permanent failures", () => {
  it("repairs an invoice left PENDING with a pdfPath (crash between the two old writes)", async () => {
    const { store, deps, sent } = setup();
    store.invoices.get("i1")!.pdfPath = "/pdf/old.pdf";
    const r = await processInvoiceJob("i1", deps);
    expect(r.outcome).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(store.invoices.get("i1")!.pdfPath).toBe("/pdf/old.pdf");
  });

  it("a permanent rejection (bounce) abandons the invoice at once and is not retried", async () => {
    let calls = 0;
    const { store, deps } = setup(async () => { calls++; throw new EmailPermanentError("550 no such user"); });
    const r = await processInvoiceJob("i1", deps);
    expect(r.outcome).toBe("abandoned");
    expect(store.invoices.get("i1")!.status).toBe("EMAIL_ABANDONED");
    expect(await processInvoiceJob("i1", deps)).toEqual({ outcome: "skipped", reason: "abandoned" });
    expect(calls).toBe(1);
  });

  it("transient failures stop after maxEmailAttempts and the invoice is abandoned", async () => {
    let calls = 0;
    const { store, deps } = setup(async () => { calls++; throw new Error("451 try later"); });
    deps.maxEmailAttempts = 3;
    for (let i = 0; i < 3; i++) await expect(processInvoiceJob("i1", deps)).rejects.toThrow("451");
    expect(store.invoices.get("i1")!.status).toBe("EMAIL_FAILED");
    const r = await processInvoiceJob("i1", deps);
    expect(r.outcome).toBe("abandoned");
    expect(store.invoices.get("i1")!.status).toBe("EMAIL_ABANDONED");
    expect(calls).toBe(3);
  });

  it("classifies SMTP 5xx and EENVELOPE as permanent, 4xx and auth as not", () => {
    expect(isPermanentSmtpError({ responseCode: 550 })).toBe(true);
    expect(isPermanentSmtpError({ code: "EENVELOPE" })).toBe(true);
    expect(isPermanentSmtpError({ responseCode: 451 })).toBe(false);
    expect(isPermanentSmtpError({ code: "EAUTH" })).toBe(false);
  });
});
