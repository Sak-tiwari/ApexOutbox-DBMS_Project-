import { describe, expect, it } from "vitest";
import { checkUrl } from "../../src/scraper/safeUrl";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
const ok = async (u: string, o = {}) => (await checkUrl(u, { lookup: publicDns, ...o })).ok;

describe("scraper SSRF protection", () => {
  it("accepts ordinary public http(s) sites", async () => {
    expect(await ok("https://example.com")).toBe(true);
    expect(await ok("http://example.com/contact?x=1")).toBe(true);
    expect(await ok("https://example.com:8443/")).toBe(true);
  });

  it.each([
    "ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "not a url", "",
    "https://user:pw@example.com", "https://example.com:22/", "https://example.com:6379/",
  ])("rejects %s", async (u) => { expect(await ok(u)).toBe(false); });

  it.each([
    "http://localhost/", "http://localhost./", "http://foo.localhost/", "http://printer.local/", "http://db.internal/",
    "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f.0.0.1/", "http://0.0.0.0/",
    "http://10.1.2.3/", "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/", "http://224.0.0.1/",
    "http://[::1]/", "http://[::]/", "http://[fe80::1]/", "http://[fd12:3456::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
    "http://[64:ff9b::7f00:1]/",
  ])("rejects the internal address %s", async (u) => { expect(await ok(u)).toBe(false); });

  it("rejects a public-looking name that resolves to a private address (DNS pointing inside)", async () => {
    const toPrivate = async () => [{ address: "10.0.0.5", family: 4 }];
    expect((await checkUrl("https://evil.example", { lookup: toPrivate })).ok).toBe(false);
    const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
    expect((await checkUrl("https://evil.example", { lookup: mixed })).ok).toBe(false);
    const v6 = async () => [{ address: "::1", family: 6 }];
    expect((await checkUrl("https://evil.example", { lookup: v6 })).ok).toBe(false);
  });

  it("rejects names that do not resolve", async () => {
    const r = await checkUrl("https://nope.example", { lookup: async () => { throw new Error("ENOTFOUND"); } });
    expect(r.ok).toBe(false);
  });

  it("allows loopback ONLY for /demo/ pages and only when enabled", async () => {
    expect(await ok("http://127.0.0.1:3000/demo/bakery.html", { allowLoopback: true })).toBe(true);
    expect(await ok("http://localhost:3000/demo/bakery.html", { allowLoopback: true })).toBe(true);
    expect(await ok("http://127.0.0.1:3000/demo/bakery.html")).toBe(false);
    expect(await ok("http://127.0.0.1:3000/api/leads", { allowLoopback: true })).toBe(false);
    expect(await ok("http://127.0.0.1:3000/demofoo", { allowLoopback: true })).toBe(false);
    expect(await ok("http://10.0.0.1/demo/x.html", { allowLoopback: true })).toBe(false);
    expect(await ok("http://169.254.169.254/demo/x", { allowLoopback: true })).toBe(false);
  });
});
