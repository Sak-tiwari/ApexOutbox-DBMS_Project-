import { describe, it, expect } from "vitest";
import { parseEnv } from "../src/config/env.js";

const valid = {
  MONGODB_URI: "mongodb://localhost:27017/apexoutbox",
  REDIS_URL: "redis://localhost:6379",
};

describe("env validation", () => {
  it("applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.DEFAULT_TENANT_SLUG).toBe("internal");
  });

  it("coerces PORT from a string", () => {
    expect(parseEnv({ ...valid, PORT: "4100" }).PORT).toBe(4100);
  });

  it("fails fast with a readable message", () => {
    expect(() => parseEnv({ REDIS_URL: "redis://x" })).toThrow(/MONGODB_URI/);
    expect(() => parseEnv({ ...valid, MONGODB_URI: "postgres://nope" })).toThrow(/mongodb/);
    expect(() => parseEnv({ ...valid, PORT: "99999" })).toThrow(/PORT/);
  });
});
