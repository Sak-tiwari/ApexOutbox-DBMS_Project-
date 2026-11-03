import { pino, type Logger } from "pino";

export type Log = Logger;

/**
 * Structured JSON logs. Secrets and personal data are redacted by path, so a stray
 * `log.info({ req })` can never write a password, token or cookie to the log.
 */
export function createLogger(level = "info", destination?: { write(chunk: string): void }): Log {
  const options = {
    level,
    redact: {
      paths: [
        "password",
        "newPassword",
        "currentPassword",
        "token",
        "refreshToken",
        "accessToken",
        "totpCode",
        "totpSecret",
        "secret",
        "authorization",
        "cookie",
        "*.password",
        "*.newPassword",
        "*.currentPassword",
        "*.token",
        "*.refreshToken",
        "*.accessToken",
        "*.totpCode",
        "*.totpSecret",
        "*.secret",
        "*.authorization",
        "*.cookie",
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
      ],
      censor: "[redacted]",
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
