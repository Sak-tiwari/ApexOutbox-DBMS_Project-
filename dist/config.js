"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseConfig = parseConfig;
exports.parseApiKeys = parseApiKeys;
const zod_1 = require("zod");
/**
 * One validated configuration object for every process (API, worker).
 * The process refuses to start on a bad configuration instead of failing later.
 */
const schema = zod_1.z
    .object({
    NODE_ENV: zod_1.z.enum(["development", "test", "production"]).default("development"),
    PORT: zod_1.z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: zod_1.z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    MONGODB_URI: zod_1.z.string().refine((v) => /^mongodb(\+srv)?:\/\//.test(v), "must start with mongodb:// or mongodb+srv://"),
    REDIS_URL: zod_1.z.string().refine((v) => /^rediss?:\/\//.test(v), "must start with redis:// or rediss://"),
    // "key1:userA,key2:userB" - each API key maps to one user id (the lead owner id).
    API_KEYS: zod_1.z.string().default(""),
    SMTP_HOST: zod_1.z.string().default(""),
    SMTP_PORT: zod_1.z.coerce.number().int().default(587),
    SMTP_USER: zod_1.z.string().default(""),
    SMTP_PASS: zod_1.z.string().default(""),
    EMAIL_FROM: zod_1.z.string().default("no-reply@example.com"),
    INVOICE_DIR: zod_1.z.string().default("generated-invoices"),
    // Requests per minute per client IP on /api (0 disables). Per process; see src/middleware/rateLimit.ts.
    RATE_LIMIT_PER_MINUTE: zod_1.z.coerce.number().int().min(0).default(300),
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
function parseConfig(source = process.env) {
    const result = schema.safeParse(source);
    if (!result.success) {
        const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
        throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
    }
    return result.data;
}
/** Parses "key:user,key2:user2" into a map. Keys shorter than 16 chars are rejected as guessable. */
function parseApiKeys(raw) {
    const map = new Map();
    for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
        const idx = part.indexOf(":");
        if (idx <= 0 || idx === part.length - 1)
            throw new Error("API_KEYS entries must look like key:userId");
        const key = part.slice(0, idx);
        const user = part.slice(idx + 1);
        if (key.length < 16)
            throw new Error("API_KEYS keys must be at least 16 characters");
        map.set(key, user);
    }
    return map;
}
//# sourceMappingURL=config.js.map