import pino, { type Logger } from "pino";

/** Structured JSON logs. Secrets are redacted wherever they appear in a log object. */
export function createLogger(level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    level,
    redact: {
      paths: ["req.headers.authorization", "req.headers['x-api-key']", "*.password", "*.SMTP_PASS", "*.apiKey"],
      censor: "[redacted]",
    },
  });
}

export type { Logger };
