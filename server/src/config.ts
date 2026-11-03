import { z } from "zod";

/**
 * One validated configuration object for every process (API, worker).
 * The process refuses to start on a bad configuration instead of failing later.
 * Secrets come from environment variables only (never from files in the repo).
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Connection used by the running app: the limited role (apex_app) so Row-Level Security applies.
  DATABASE_URL: z
    .string()
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "must start with postgres:// or postgresql://"),
  // Connection used ONLY by `npm run db:migrate` (schema owner). Never used by the running app.
  MIGRATION_DATABASE_URL: z
    .string()
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "must start with postgres:// or postgresql://")
    .optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

export type Config = z.infer<typeof schema>;

export function parseConfig(source: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}
