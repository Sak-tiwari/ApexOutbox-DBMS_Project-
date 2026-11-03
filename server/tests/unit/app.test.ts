import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { parseConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { createPool } from "../../src/db/pool.js";
import { appPool, closePools } from "../helpers/db.js";

afterAll(closePools);

const log = createLogger("silent");

describe("health endpoints", () => {
  it("GET /health is 200 without touching the database", async () => {
    const dead = createPool("postgres://nobody:nope@127.0.0.1:1/none", { max: 1 });
    const res = await request(createApp({ db: dead, log })).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    await dead.end();
  });

  it("GET /ready is 200 when the database answers", async () => {
    const res = await request(createApp({ db: appPool(), log })).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { database: "up" } });
  });

  it("GET /ready is 503 when the database is down", async () => {
    const dead = createPool("postgres://nobody:nope@127.0.0.1:1/none", { max: 1 });
    const res = await request(createApp({ db: dead, log })).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks.database).toBe("down");
    await dead.end();
  });
});

describe("HTTP basics", () => {
  const app = () => createApp({ db: appPool(), log });

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
  const ok = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

  it("applies safe defaults", () => {
    const c = parseConfig(ok);
    expect(c.PORT).toBe(3000);
    expect(c.NODE_ENV).toBe("development");
    expect(c.DB_POOL_MAX).toBe(10);
  });

  it("refuses to start without a database URL or with a non-postgres one", () => {
    expect(() => parseConfig({})).toThrow(/DATABASE_URL/);
    expect(() => parseConfig({ DATABASE_URL: "mongodb://localhost/x" })).toThrow(/postgres/);
  });

  it("rejects an out-of-range port", () => {
    expect(() => parseConfig({ ...ok, PORT: "70000" })).toThrow(/PORT/);
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
