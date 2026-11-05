import { z } from "zod";

/**
 * One validated configuration object for every process (API, worker).
 * The process refuses to start on a bad configuration instead of failing later.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    MONGODB_URI: z.string().refine((v) => /^mongodb(\+srv)?:\/\//.test(v), "must start with mongodb:// or mongodb+srv://"),
    REDIS_URL: z.string().refine((v) => /^rediss?:\/\//.test(v), "must start with redis:// or rediss://"),
    // "key1:userA,key2:userB" - each API key maps to one user id (the lead owner id).
    API_KEYS: z.string().default(""),
    SMTP_HOST: z.string().default(""),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_USER: z.string().default(""),
    SMTP_PASS: z.string().default(""),
    EMAIL_FROM: z.string().default("no-reply@example.com"),
    INVOICE_DIR: z.string().default("generated-invoices"),
    // Requests per minute per client IP on /api (0 disables). Per process; see src/middleware/rateLimit.ts.
    // Lets the scraper fetch the bundled demo pages on this machine (http://127.0.0.1/demo/...). Only those
    // pages; other local addresses stay blocked. On by default outside production.
    SCRAPER_ALLOW_LOOPBACK: z.enum(["true", "false"]).optional(),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(300),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      if (!env.API_KEYS.trim()) {
        ctx.addIssue({ code: "custom", path: ["API_KEYS"], message: "required in production" });
      }
      if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
        // Without this check the email module falls back to DEMO mode, which marks invoices as
        // sent without sending anything.
        ctx.addIssue({ code: "custom", path: ["SMTP_HOST"], message: "SMTP_HOST/SMTP_USER/SMTP_PASS are required in production" });
      }
    }
  });

export type Config = z.infer<typeof schema> & { scraperAllowLoopback: boolean };

export function parseConfig(source: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const d = result.data;
  return { ...d, scraperAllowLoopback: d.SCRAPER_ALLOW_LOOPBACK ? d.SCRAPER_ALLOW_LOOPBACK === "true" : d.NODE_ENV !== "production" };
}

/** Parses "key:user,key2:user2" into a map. Keys shorter than 16 chars are rejected as guessable. */
export function parseApiKeys(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(":");
    if (idx <= 0 || idx === part.length - 1) throw new Error("API_KEYS entries must look like key:userId");
    const key = part.slice(0, idx);
    const user = part.slice(idx + 1);
    if (key.length < 16) throw new Error("API_KEYS keys must be at least 16 characters");
    map.set(key, user);
  }
  return map;
}
