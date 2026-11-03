import { describe, expect, it } from "vitest";
import { parseApiKeys, parseConfig } from "../../src/config";

const base = { MONGODB_URI: "mongodb://localhost:27017/x", REDIS_URL: "redis://localhost:6379" };

describe("config", () => {
  it("accepts a minimal development config", () => {
    expect(parseConfig(base).PORT).toBe(3000);
  });
  it("fails fast with readable messages", () => {
    expect(() => parseConfig({ REDIS_URL: "redis://x" })).toThrow(/MONGODB_URI/);
    expect(() => parseConfig({ ...base, MONGODB_URI: "postgres://x" })).toThrow(/mongodb/);
  });
  it("production requires API keys and SMTP (no silent demo mode)", () => {
    expect(() => parseConfig({ ...base, NODE_ENV: "production" })).toThrow(/API_KEYS/);
    expect(() => parseConfig({ ...base, NODE_ENV: "production", API_KEYS: "k".repeat(20) + ":ownerA" })).toThrow(/SMTP_HOST/);
    expect(parseConfig({ ...base, NODE_ENV: "production", API_KEYS: "k".repeat(20) + ":ownerA", SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p" }).NODE_ENV).toBe("production");
  });
  it("parses API keys and rejects weak or malformed ones", () => {
    const key = "a".repeat(24);
    expect(parseApiKeys(`${key}:ownerA, ${"b".repeat(24)}:ownerB`).get(key)).toBe("ownerA");
    expect(() => parseApiKeys("short:ownerA")).toThrow(/16 characters/);
    expect(() => parseApiKeys("nokeyvalue")).toThrow(/key:userId/);
  });
});
