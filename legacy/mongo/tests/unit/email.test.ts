import { describe, expect, it } from "vitest";
import { EmailUncertainError, isUncertainSmtpError, sendInvoiceEmail, type Mailer } from "../../src/phase4/email";

const details = { to: "asha@example.com", clientName: "Asha", invoiceNumber: "INV-1", pdfPath: "/tmp/x.pdf" };
const withCode = (code: string) => Object.assign(new Error(code), { code });
const mailer = (fn: Mailer["sendMail"]): Mailer => ({ sendMail: fn });

describe("email error classification", () => {
  it.each(["ETIMEDOUT", "ESOCKET", "ECONNRESET", "EPIPE", "ECONNABORTED"])("%s is uncertain (may have been delivered)", (code) => {
    expect(isUncertainSmtpError(withCode(code))).toBe(true);
  });
  it.each(["EAUTH", "ECONNREFUSED", "ENOTFOUND", "EDNS", "EENVELOPE", "EMESSAGE"])("%s is a definite failure", (code) => {
    expect(isUncertainSmtpError(withCode(code))).toBe(false);
  });
  it("handles non-error input", () => {
    expect(isUncertainSmtpError(undefined)).toBe(false);
    expect(isUncertainSmtpError("boom")).toBe(false);
  });
});

describe("sendInvoiceEmail", () => {
  it("returns the provider message id and sends a deterministic Message-ID", async () => {
    let seen: Record<string, unknown> = {};
    const out = await sendInvoiceEmail(details, { env: { EMAIL_FROM: "billing@acme.in" }, transport: mailer(async (o) => { seen = o; return { messageId: String(o.messageId) }; }) });
    expect(seen.messageId).toBe("<INV-1@acme.in>");
    expect(out).toEqual({ messageId: "<INV-1@acme.in>", demo: false });
  });

  it("turns a timeout into EmailUncertainError (so the caller does not resend blindly)", async () => {
    await expect(sendInvoiceEmail(details, { env: {}, transport: mailer(async () => { throw withCode("ETIMEDOUT"); }) })).rejects.toBeInstanceOf(EmailUncertainError);
  });

  it("leaves definite failures as ordinary errors (safe to retry)", async () => {
    const err = await sendInvoiceEmail(details, { env: {}, transport: mailer(async () => { throw withCode("ECONNREFUSED"); }) }).catch((e) => e);
    expect(err).not.toBeInstanceOf(EmailUncertainError);
    expect(err.code).toBe("ECONNREFUSED");
  });

  it("refuses demo mode in production instead of pretending the email was sent", async () => {
    await expect(sendInvoiceEmail(details, { env: { NODE_ENV: "production" } })).rejects.toThrow(/demo mode in production/);
  });

  it("still allows demo mode outside production", async () => {
    const out = await sendInvoiceEmail(details, { env: { NODE_ENV: "development" } });
    expect(out).toEqual({ messageId: "demo-INV-1", demo: true });
  });
});
