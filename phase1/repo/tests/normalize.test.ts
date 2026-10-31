import { describe, it, expect } from "vitest";
import { buildDedupeKey, normalizeDomain, normalizeEmail, normalizePhone } from "../src/domain/normalize.js";

describe("normalisation", () => {
  it("normalises domains from messy input", () => {
    expect(normalizeDomain("HTTPS://www.Example.com/about?x=1")).toBe("example.com");
    expect(normalizeDomain("example.com")).toBe("example.com");
    expect(normalizeDomain("not a url")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
  });

  it("normalises emails and rejects invalid ones", () => {
    expect(normalizeEmail("  Hello@Example.COM ")).toBe("hello@example.com");
    expect(normalizeEmail("nope")).toBeNull();
  });

  it("normalises phones to digits and keeps a leading plus", () => {
    expect(normalizePhone("+91 98765-43210")).toBe("+919876543210");
    expect(normalizePhone("(011) 2345 6789")).toBe("01123456789");
    expect(normalizePhone("123")).toBeNull();
  });
});

describe("dedupe key", () => {
  it("gives the same key for the same business reached by different fields", () => {
    const a = buildDedupeKey({ website: "https://www.acme.in/contact" });
    const b = buildDedupeKey({ email: "sales@acme.in" });
    expect(a).toBe("domain:acme.in");
    expect(b).toBe(a);
  });

  it("never uses a free-mail domain as business identity", () => {
    expect(buildDedupeKey({ email: "owner@gmail.com" })).toBe("email:owner@gmail.com");
    expect(buildDedupeKey({ email: "other@gmail.com" })).not.toBe(buildDedupeKey({ email: "owner@gmail.com" }));
  });

  it("falls back to phone, then null (manual review)", () => {
    expect(buildDedupeKey({ phone: "+91 98765 43210" })).toBe("phone:+919876543210");
    expect(buildDedupeKey({})).toBeNull();
  });
});
