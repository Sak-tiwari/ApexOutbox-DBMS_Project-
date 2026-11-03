import { z } from "zod";

const postgresUrl = z.string().refine((v) => /^postgres(ql)?:\/\//.test(v), "must start with postgres:// or postgresql://");

/**
 * One validated configuration object for every process (API, worker).
 * The process refuses to start on a bad configuration instead of failing later.
 * Secrets come from environment variables only (never from files in the repo).
 */
const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    // Connection used by the running app: the limited role (apex_app) so Row-Level Security applies.
    DATABASE_URL: postgresUrl,
    // Connection used ONLY by `npm run db:migrate` (schema owner). Never used by the running app.
    MIGRATION_DATABASE_URL: postgresUrl.optional(),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    // --- authentication ---
    // Signs access tokens (HS256). Generate with: openssl rand -base64 48
    JWT_ACCESS_SECRET: z.string().min(32, "must be at least 32 characters"),
    // AES-256-GCM key that encrypts TOTP secrets at rest: 32 random bytes, base64. openssl rand -base64 32
    TOTP_ENC_KEY: z
      .string()
      .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded (openssl rand -base64 32)"),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    // Absolute session lifetime, no matter how often the refresh token is rotated.
    REFRESH_FAMILY_MAX_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

    // --- e-mail ---
    // "smtp" sends through SMTP_*; "log" only records the message (development). Production must use smtp.
    EMAIL_MODE: z.enum(["smtp", "log"]).optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    EMAIL_FROM: z.string().max(200).optional(),
    // Where issued invoice PDFs are stored (a directory, one file per invoice). Back it up with the database.
    INVOICE_STORAGE_DIR: z.string().default("./storage/invoices"),

    // Browser origins allowed to call the API with credentials (CSRF Origin check, CORS). Comma-separated.
    ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),
    // Mark cookies Secure. Defaults to true in production, false otherwise (plain http on localhost).
    COOKIE_SECURE: z
      .enum(["true", "false"])
      .optional(),
    // Number of reverse-proxy hops in front of the API (0 = none). Needed for correct client IPs.
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  })
  .superRefine((env, ctx) => {
    for (const origin of env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)) {
      try {
        const u = new URL(origin);
        if (u.origin !== origin) throw new Error("not an origin");
        if (env.NODE_ENV === "production" && u.protocol !== "https:") {
          ctx.addIssue({ code: "custom", path: ["ALLOWED_ORIGINS"], message: `${origin} must be https in production` });
        }
      } catch {
        ctx.addIssue({ code: "custom", path: ["ALLOWED_ORIGINS"], message: `"${origin}" must be an origin like https://app.example.com (no path, no trailing slash)` });
      }
    }
    const mode = env.EMAIL_MODE ?? (env.SMTP_HOST ? "smtp" : "log");
    if (mode === "smtp" && (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.EMAIL_FROM)) {
      ctx.addIssue({ code: "custom", path: ["SMTP_HOST"], message: "SMTP_HOST, SMTP_USER, SMTP_PASS and EMAIL_FROM are all required for EMAIL_MODE=smtp" });
    }
    if (env.NODE_ENV === "production" && mode !== "smtp") {
      ctx.addIssue({ code: "custom", path: ["EMAIL_MODE"], message: "must be smtp in production (log mode would silently lose invoices)" });
    }
    if (env.NODE_ENV === "production" && env.COOKIE_SECURE === "false") {
      ctx.addIssue({ code: "custom", path: ["COOKIE_SECURE"], message: "cannot be false in production" });
    }
  })
  .transform((env) => ({
    ...env,
    allowedOrigins: env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : env.NODE_ENV === "production",
    totpKey: Buffer.from(env.TOTP_ENC_KEY, "base64"),
    emailMode: (env.EMAIL_MODE ?? (env.SMTP_HOST ? "smtp" : "log")) as "smtp" | "log",
  }));

export type Config = z.infer<typeof schema>;

export function parseConfig(source: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}
