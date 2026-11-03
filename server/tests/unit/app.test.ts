import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { parseConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { createPool } from "../../src/db/pool.js";
import { appPool, closePools } from "../helpers/db.js";
import { testConfig } from "../helpers/app.js";

afterAll(closePools);

const log = createLogger("silent");
const config = testConfig();

describe("health endpoints", () => {
  it("GET /health is 200 without touching the database", async () => {
    const dead = createPool("postgres://nobody:nope@127.0.0.1:1/none", { max: 1 });
    const res = await request(createApp({ db: dead, log, config })).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    await dead.end();
  });

  it("GET /ready is 200 when the database answers", async () => {
    const res = await request(createApp({ db: appPool(), log, config })).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { database: "up" } });
  });

  it("GET /ready is 503 when the database is down", async () => {
    const dead = createPool("postgres://nobody:nope@127.0.0.1:1/none", { max: 1 });
    const res = await request(createApp({ db: dead, log, config })).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks.database).toBe("down");
    await dead.end();
  });
});

describe("HTTP basics", () => {
  const app = () => createApp({ db: appPool(), log, config });

  it("unknown routes return the standard error shape", async () => {
    const res = await request(app()).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  it("malformed JSON is a 400, not a 500", async () => {
    const res = await request(app()).post("/api/x").set("content-type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("oversized bodies are rejected with 413", async () => {
    const res = await request(app()).post("/api/x").send({ blob: "x".repeat(200_000) });
    expect(res.status).toBe(413);
  });

  it("does not advertise Express and always sets a request id", async () => {
    const res = await request(app()).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-request-id"]).toBeTruthy();
  });
});

describe("configuration", () => {
  const ok = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    JWT_ACCESS_SECRET: "x".repeat(40),
    TOTP_ENC_KEY: Buffer.alloc(32, 1).toString("base64"),
  };

  it("applies safe defaults", () => {
    const c = parseConfig(ok);
    expect(c.PORT).toBe(3000);
    expect(c.NODE_ENV).toBe("development");
    expect(c.DB_POOL_MAX).toBe(10);
    expect(c.ACCESS_TOKEN_TTL_SECONDS).toBe(600);
    expect(c.cookieSecure).toBe(false);
    expect(c.allowedOrigins).toEqual(["http://localhost:5173"]);
  });

  it("refuses to start without a database URL or with a non-postgres one", () => {
    expect(() => parseConfig({ ...ok, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => parseConfig({ ...ok, DATABASE_URL: "mongodb://localhost/x" })).toThrow(/postgres/);
  });

  it("refuses weak or missing secrets", () => {
    expect(() => parseConfig({ ...ok, JWT_ACCESS_SECRET: "short" })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => parseConfig({ ...ok, JWT_ACCESS_SECRET: undefined })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => parseConfig({ ...ok, TOTP_ENC_KEY: Buffer.alloc(16).toString("base64") })).toThrow(/TOTP_ENC_KEY/);
  });

  it("rejects an out-of-range port", () => {
    expect(() => parseConfig({ ...ok, PORT: "70000" })).toThrow(/PORT/);
  });

  const smtp = { SMTP_HOST: "smtp.example.com", SMTP_USER: "u", SMTP_PASS: "p", EMAIL_FROM: "billing@example.com" };

  it("production forces secure cookies and https origins", () => {
    const prod = { ...ok, ...smtp, NODE_ENV: "production" };
    expect(parseConfig({ ...prod, ALLOWED_ORIGINS: "https://app.example.com" }).cookieSecure).toBe(true);
    expect(() => parseConfig({ ...prod, ALLOWED_ORIGINS: "http://app.example.com" })).toThrow(/https/);
    expect(() => parseConfig({ ...prod, ALLOWED_ORIGINS: "https://app.example.com", COOKIE_SECURE: "false" })).toThrow(/COOKIE_SECURE/);
  });

  it("e-mail: log mode by default in development, smtp when configured, never log mode in production", () => {
    expect(parseConfig(ok).emailMode).toBe("log");
    expect(parseConfig({ ...ok, ...smtp }).emailMode).toBe("smtp");
    expect(() => parseConfig({ ...ok, SMTP_HOST: "smtp.example.com" })).toThrow(/SMTP_USER/);
    expect(() => parseConfig({ ...ok, NODE_ENV: "production", ALLOWED_ORIGINS: "https://a.example.com" })).toThrow(/EMAIL_MODE/);
    expect(() => parseConfig({ ...ok, ...smtp, EMAIL_MODE: "log", NODE_ENV: "production", ALLOWED_ORIGINS: "https://a.example.com" })).toThrow(/EMAIL_MODE/);
  });

  it("origins must be bare origins", () => {
    expect(() => parseConfig({ ...ok, ALLOWED_ORIGINS: "https://app.example.com/" })).toThrow(/ALLOWED_ORIGINS/);
    expect(() => parseConfig({ ...ok, ALLOWED_ORIGINS: "https://a.example.com/path" })).toThrow(/ALLOWED_ORIGINS/);
  });
});

describe("log redaction", () => {
  it("never writes passwords, tokens, TOTP codes or cookies", () => {
    const chunks: string[] = [];
    const logger = createLogger("info", { write: (s) => void chunks.push(s) });
    logger.info(
      {
        password: "hunter2",
        body: { newPassword: "hunter3", refreshToken: "rt-secret", totpCode: "123456" },
        req: { headers: { authorization: "Bearer abc.def.ghi", cookie: "refresh=rt-secret" } },
      },
      "login attempt",
    );
    const out = chunks.join("");
    for (const secret of ["hunter2", "hunter3", "rt-secret", "123456", "abc.def.ghi"]) {
      expect(out, `log leaked ${secret}`).not.toContain(secret);
    }
    expect(out).toContain("[redacted]");
    expect(out).toContain("login attempt");
  });
});
