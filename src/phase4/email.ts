import "dotenv/config";
import nodemailer from "nodemailer";

interface EmailDetails {
  to: string;
  clientName: string;
  invoiceNumber: string;
  /** The number printed on the invoice (may contain /). Shown in the subject; the internal number keeps the Message-ID stable. */
  displayNumber?: string;
  pdfPath: string;
}

export interface Mailer {
  sendMail(options: Record<string, unknown>): Promise<{ messageId: string }>;
}

export interface EmailOptions {
  env?: Record<string, string | undefined>;
  /** Injected in tests. Defaults to a real SMTP transport built from env. */
  transport?: Mailer;
}

/**
 * Thrown when we cannot tell whether the provider accepted the message (timeout or dropped
 * connection AFTER we may have sent data). The caller must NOT blindly resend: that could deliver
 * the same invoice twice.
 */
export class EmailUncertainError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "EmailUncertainError";
  }
}

/** The provider definitively rejected the message (e.g. SMTP 550 mailbox does not exist). Retrying cannot help. */
export class EmailPermanentError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "EmailPermanentError";
  }
}

export function isPermanentSmtpError(error: unknown): boolean {
  const e = error as { code?: string; responseCode?: number } | null;
  if (e?.code === "EENVELOPE") return true;
  return typeof e?.responseCode === "number" && e.responseCode >= 500 && e.responseCode < 600;
}

// Codes meaning "the connection broke or timed out; the server may or may not have queued the mail".
// Conservative on purpose: ETIMEDOUT can also happen before any data was sent, but treating it as
// uncertain only costs a manual check, while a wrong "safe to retry" can double-send an invoice.
const UNCERTAIN_CODES = new Set(["ETIMEDOUT", "ESOCKET", "ECONNRESET", "EPIPE", "ECONNABORTED"]);

export function isUncertainSmtpError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === "string" && UNCERTAIN_CODES.has(code);
}

function messageIdFor(invoiceNumber: string, from: string): string {
  const domain = from.includes("@") ? from.split("@").pop()!.replace(/[^A-Za-z0-9.-]/g, "") : "localhost";
  // Deterministic: the same invoice always carries the same Message-ID, so a provider or recipient
  // can be asked "did you get <this id>?" when the outcome is uncertain.
  return `<${invoiceNumber}@${domain || "localhost"}>`;
}

export async function sendInvoiceEmail(
  details: EmailDetails,
  options: EmailOptions = {}
): Promise<{ messageId: string; demo: boolean }> {
  const env = options.env ?? process.env;
  const { SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_PORT, EMAIL_FROM, NODE_ENV } = env;

  if (!options.transport && (!SMTP_HOST || !SMTP_USER || !SMTP_PASS)) {
    if (NODE_ENV === "production") {
      // Demo mode reports success without sending anything. In production that would silently
      // lose invoices, so refuse instead.
      throw new Error("SMTP is not configured; refusing to run in demo mode in production");
    }
    console.log("[DEMO EMAIL]", {
      to: details.to,
      invoiceNumber: details.invoiceNumber,
      pdfPath: details.pdfPath
    });

    return {
      messageId: `demo-${details.invoiceNumber}`,
      demo: true
    };
  }

  const port = Number(SMTP_PORT || 587);
  const from = EMAIL_FROM || SMTP_USER || "no-reply@localhost";
  const transport: Mailer =
    options.transport ??
    (nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // Explicit, short timeouts. nodemailer defaults (2 min connect, 10 min socket) would keep a
      // worker slot blocked for a very long time during a provider outage.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000
    }) as unknown as Mailer);

  try {
    const result = await transport.sendMail({
      from,
      to: details.to,
      messageId: messageIdFor(details.invoiceNumber, from),
      subject: `Your invoice ${details.displayNumber || details.invoiceNumber}`,
      text: `Hi ${details.clientName},

Thank you for choosing us. Your invoice is attached.`,
      attachments: [
        {
          filename: `${(details.displayNumber || details.invoiceNumber).replace(/[^A-Za-z0-9._-]/g, "-")}.pdf`,
          path: details.pdfPath
        }
      ]
    });

    return { messageId: result.messageId, demo: false };
  } catch (error) {
    if (isUncertainSmtpError(error)) {
      throw new EmailUncertainError(`Email outcome unknown for ${details.invoiceNumber}: ${String(error)}`, error);
    }
    if (isPermanentSmtpError(error)) {
      throw new EmailPermanentError(`Email rejected for ${details.invoiceNumber}: ${String(error)}`, error);
    }
    throw error;
  }
}
