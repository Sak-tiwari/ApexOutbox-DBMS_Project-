import { z } from "zod";

/**
 * Environment validation. The process refuses to start with a bad config
 * instead of failing later in some unrelated place.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  MONGODB_URI: z
    .string()
    .refine((v) => v.startsWith("mongodb://") || v.startsWith("mongodb+srv://"), {
      message: "must start with mongodb:// or mongodb+srv://",
    }),
  REDIS_URL: z
    .string()
    .refine((v) => v.startsWith("redis://") || v.startsWith("rediss://"), {
      message: "must start with redis:// or rediss://",
    }),
  DEFAULT_TENANT_SLUG: z.string().min(1).default("internal"),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
