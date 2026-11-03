import nodemailer from "nodemailer";
import type { Config } from "../config.js";
import type { Log } from "../logger.js";

export interface OutgoingMail {
  /** Stable per outbox row: asking a provider "did you get <id>?" is how an UNCERTAIN send gets resolved. */
  messageId: string;
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<{ providerMessageId: string }>;
}

/** The provider definitively refused the message (e.g. SMTP 5xx). Retrying cannot help. */
export class EmailPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailPermanentError";
  }
}
/**
 * We cannot tell whether the provider accepted the message (connection dropped or timed out after we may have sent
 * data). Never retried automatically: that could deliver the same invoice twice.
 */
export class EmailUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailUncertainError";
  }
}

const UNCERTAIN_CODES = new Set(["ETIMEDOUT", "ESOCKET", "ECONNRESET", "EPIPE", "ECONNABORTED"]);

/** Maps a transport error to one of: permanent, uncertain, or (re-thrown unchanged) a plain retryable failure. */
export function classifySmtpError(error: unknown): Error {
  const e = error as { code?: string; responseCode?: number; message?: string } | null;
  const text = String(e?.message ?? error).slice(0, 300);
  if (e?.code === "EENVELOPE" || (typeof e?.responseCode === "number" && e.responseCode >= 500 && e.responseCode < 600)) {
    return new EmailPermanentError(text);
  }
  if (typeof e?.code === "string" && UNCERTAIN_CODES.has(e.code)) return new EmailUncertainError(text);
  return error instanceof Error ? error : new Error(text);
}

export function createMailer(config: Pick<Config, "emailMode" | "SMTP_HOST" | "SMTP_PORT" | "SMTP_USER" | "SMTP_PASS" | "EMAIL_FROM">, log: Log): Mailer {
  if (config.emailMode === "log") {
    return {
      async send(mail) {
        log.info({ messageId: mail.messageId, attachments: mail.attachments?.length ?? 0 }, "EMAIL (log mode, not sent)");
        return { providerMessageId: `log-${mail.messageId}` };
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    // Short, explicit timeouts so a provider outage cannot hold a worker for minutes.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  return {
    async send(mail) {
      try {
        const info = await transport.sendMail({
          from: config.EMAIL_FROM,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          messageId: mail.messageId,
          attachments: mail.attachments,
        });
        return { providerMessageId: info.messageId };
      } catch (err) {
        throw classifySmtpError(err);
      }
    },
  };
}
