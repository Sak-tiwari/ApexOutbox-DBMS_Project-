import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCandidate } from "../../src/scraper/extract.js";
import { FetchError, SafeFetcher } from "../../src/scraper/fetch.js";
import { parseRobots } from "../../src/scraper/robots.js";
import { BlockedTargetError, checkUrlShape, hostAllowed, isBlockedIp, resolvePublic } from "../../src/scraper/ssrf.js";

describe("isBlockedIp", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "100.64.0.1", "100.127.255.255", "192.0.0.8", "198.18.0.1", "224.0.0.1", "255.255.255.255", "203.0.113.5",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1",
    "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::", "0:0:0:0:0:0:0:1", "not-an-ip", "",
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2002:808:808::"])(
    "allows public %s",
    (ip) => expect(isBlockedIp(ip)).toBe(false),
  );
});

describe("checkUrlShape", () => {
  it.each([
    "file:///etc/passwd", "ftp://example.com", "gopher://example.com", "javascript:alert(1)", "http://user:pw@example.com/",
    "http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://2130706433/", "http://0x7f.0.0.1/", "http://0177.0.0.1/",
    "http://intranet/", "http://printer.local/", "http://metadata.google.internal/", "https://example.com:8443/", "http://example.com:22/", "nonsense",
    "http://169.254.169.254/latest/meta-data/",
  ])("rejects %s", (u) => expect(() => checkUrlShape(u)).toThrow(BlockedTargetError));

  it("accepts ordinary public URLs", () => {
    expect(checkUrlShape("https://www.example.com/contact?x=1").hostname).toBe("www.example.com");
    expect(checkUrlShape("http://example.com:80/").hostname).toBe("example.com");
  });
});

describe("resolvePublic", () => {
  it("refuses when ANY answer is internal (mixed public/private records)", async () => {
    const r = async () => [{ address: "93.184.216.34", family: 4 as const }, { address: "10.0.0.5", family: 4 as const }];
    await expect(resolvePublic("evil.example.com", r)).rejects.toThrow(/non-public/);
  });
  it("refuses unresolvable hosts and returns the first public answer otherwise", async () => {
    await expect(resolvePublic("x.example.com", async () => { throw new Error("ENOTFOUND"); })).rejects.toThrow(/resolved/);
    await expect(resolvePublic("x.example.com", async () => [])).rejects.toThrow(/resolved/);
    expect(await resolvePublic("ok.example.com", async () => [{ address: "93.184.216.34", family: 4 }])).toEqual({ address: "93.184.216.34", family: 4 });
  });
});

describe("hostAllowed", () => {
  it("matches the domain and its subdomains only", () => {
    expect(hostAllowed("acme.com", ["acme.com"])).toBe(true);
    expect(hostAllowed("shop.acme.com", ["acme.com"])).toBe(true);
    expect(hostAllowed("ACME.com.", ["acme.com"])).toBe(true);
    expect(hostAllowed("evilacme.com", ["acme.com"])).toBe(false);
    expect(hostAllowed("acme.com.evil.io", ["acme.com"])).toBe(false);
    expect(hostAllowed("acme.com", [])).toBe(false);
  });
});

describe("robots.txt", () => {
  const txt = `
User-agent: *
Disallow: /private/
Disallow: /*.pdf$
Allow: /private/public-note
Crawl-delay: 4

User-agent: ApexOutboxBot
Disallow: /secret
`;
  it("uses the most specific group for our agent", () => {
    const r = parseRobots(txt, "ApexOutboxBot/1.0");
    expect(r.isAllowed("/secret/page")).toBe(false);
    expect(r.isAllowed("/private/")).toBe(true); // the * group does not apply to us
    expect(r.crawlDelay).toBeUndefined();
  });
  it("falls back to * with longest-match, wildcards, $ anchors and Allow overrides", () => {
    const r = parseRobots(txt, "OtherBot");
    expect(r.isAllowed("/private/x")).toBe(false);
    expect(r.isAllowed("/private/public-note")).toBe(true);
    expect(r.isAllowed("/files/a.pdf")).toBe(false);
    expect(r.isAllowed("/files/a.pdf?x=1")).toBe(true);
    expect(r.isAllowed("/about")).toBe(true);
    expect(r.crawlDelay).toBe(4);
  });
  it("treats empty Disallow as allow-all, ignores comments/garbage, and tolerates huge input", () => {
    expect(parseRobots("User-agent: *\nDisallow:\n", "x").isAllowed("/anything")).toBe(true);
    expect(parseRobots("# nothing\n???\n", "x").isAllowed("/a")).toBe(true);
    expect(parseRobots("User-agent: *\nDisallow: /\n", "x").isAllowed("/a")).toBe(false);
    expect(() => parseRobots("a".repeat(5_000_000), "x")).not.toThrow();
  });
  it("Allow wins a tie", () => {
    expect(parseRobots("User-agent: *\nDisallow: /a\nAllow: /a\n", "x").isAllowed("/a")).toBe(true);
  });
});

describe("extractCandidate", () => {
  const page = (body: string, head = "<title>Blossom Studios | Luxury Salon</title>") => `<html><head>${head}</head><body>${body}</body></html>`;

  it("pulls company, best e-mail (own domain + role address first), phone and origin", () => {
    const html = page(`<h1>Welcome</h1><a href="mailto:Owner@gmail.com">x</a> Write to INFO@blossom.example.com or press@other.org
      <a href="tel:+91 98765-43210">call</a><img src="logo@2x.png"><script>var e="hack@evil.example.com"</script>`);
    expect(extractCandidate(html, "https://www.blossom.example.com/contact?utm=1")).toEqual({
      name: "Blossom Studios", companyName: "Blossom Studios", email: "info@blossom.example.com", phone: "+919876543210",
      website: "https://www.blossom.example.com", sourceUrl: "https://www.blossom.example.com/contact?utm=1",
    });
  });
  it("drops images, no-reply addresses and script contents; returns null email when none", () => {
    const c = extractCandidate(page(`<p>noreply@site.example.com sprite@2x.png</p><script>a@b.example.com</script>`), "https://site.example.com/")!;
    expect(c.email).toBeNull();
  });
  it("falls back to og:site_name, then h1; returns null when there is no name", () => {
    expect(extractCandidate(page("", `<meta property="og:site_name" content="Acme Co"><title>Home</title>`), "https://acme.example.com")!.name).toBe("Acme Co");
    expect(extractCandidate(page("<h1>Only Heading</h1>", ""), "https://x.example.com")!.name).toBe("Only Heading");
    expect(extractCandidate("<html></html>", "https://x.example.com")).toBeNull();
  });
  it("sanitises control characters and caps field length", () => {
    const c = extractCandidate(page("", `<title>${"A".repeat(500)}</title>`), "https://x.example.com")!;
    expect(c.name.length).toBe(200);
    expect(extractCandidate(page("", "<title>Bad\u0000Name\u0007</title>"), "https://x.example.com")!.name).toBe("Bad Name");
  });
});

describe("SafeFetcher", () => {
  let server: Server;
  let base: string;
  let hits: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      const u = req.url ?? "/";
      if (u === "/ok") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<title>Hi</title>hello");
      if (u === "/json") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      if (u === "/big") return void res.writeHead(200, { "content-type": "text/html" }).end("x".repeat(5000));
      if (u === "/r1") return void res.writeHead(302, { location: "/ok" }).end();
      if (u === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
      if (u === "/to-internal") return void res.writeHead(302, { location: "http://internal.example.com/ok" }).end();
      if (u === "/to-meta") return void res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      if (u === "/to-file") return void res.writeHead(302, { location: "file:///etc/passwd" }).end();
      if (u === "/to-offlist") return void res.writeHead(302, { location: "http://elsewhere.example.net/" }).end();
      if (u === "/slow") return; // never answers
      res.writeHead(404, { "content-type": "text/plain" }).end("nope");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

  // Test seam: pretend example hosts live on this machine's loopback test server. The strict defaults are tested below.
  const lenient = (extra: Record<string, unknown> = {}) =>
    new SafeFetcher({
      allowedDomains: () => ["site.example.com", "internal.example.com"],
      resolver: async (h: string) => [{ address: h === "internal.example.com" ? "10.0.0.9" : "127.0.0.1", family: 4 }],
      isBlocked: (ip: string) => ip.startsWith("10.") || ip.startsWith("169.254."),
      get allowedPorts() { return [Number(base)]; },
      ...extra,
    } as never);
  const url = (p: string) => `http://site.example.com:${base}${p}`;

  it("fetches an allowed page (connecting to the pinned address, Host header intact)", async () => {
    const page = await lenient().fetch(url("/ok"));
    expect(page).toMatchObject({ status: 200, body: "<title>Hi</title>hello", truncated: false });
  });
  it("follows redirects on the same allowed host", async () => {
    expect((await lenient().fetch(url("/r1"))).body).toContain("hello");
  });
  it("refuses a redirect to an internal address, a metadata IP, a file URL, an off-list domain, and redirect loops", async () => {
    for (const p of ["/to-internal", "/to-meta", "/to-file", "/to-offlist"]) {
      await expect(lenient().fetch(url(p)), p).rejects.toMatchObject({ kind: "blocked" });
    }
    await expect(lenient().fetch(url("/loop"))).rejects.toThrow(/redirects/);
  });
  it("truncates oversized bodies, rejects non-text content, times out slow servers", async () => {
    const big = await lenient({ maxBytes: 1000 }).fetch(url("/big"));
    expect(big.truncated).toBe(true);
    expect(big.body.length).toBe(1000);
    await expect(lenient().fetch(url("/json"))).rejects.toMatchObject({ kind: "content" });
    await expect(lenient({ timeoutMs: 200 }).fetch(url("/slow"))).rejects.toThrow(/Timed out/);
  });
  it("never sends a request for a blocked target", async () => {
    hits = [];
    await expect(lenient().fetch(`http://other.example.org:${base}/ok`)).rejects.toMatchObject({ kind: "blocked" });
    expect(hits).toEqual([]);
  });

  describe("production defaults", () => {
    const strict = new SafeFetcher({ allowedDomains: () => ["localtest.me", "example.com"], resolver: async () => [{ address: "127.0.0.1", family: 4 }] });
    it("refuses a domain that resolves to loopback (DNS pointing at internal hosts)", async () => {
      await expect(strict.fetch("https://www.example.com/")).rejects.toMatchObject({ kind: "blocked", message: expect.stringMatching(/non-public/) });
    });
    it("refuses IP literals, localhost and unapproved domains before any DNS", async () => {
      for (const u of ["http://127.0.0.1/", "http://[::1]/", "http://localhost/", "http://169.254.169.254/", "https://notapproved.org/"]) {
        await expect(strict.fetch(u), u).rejects.toBeInstanceOf(FetchError);
      }
    });
    it("DNS rebinding: the first answer is public, a later lookup is not; the socket still uses the vetted answer", async () => {
      let calls = 0;
      const rebinding = new SafeFetcher({
        allowedDomains: () => ["rebind.example.com"],
        resolver: async () => (++calls === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]),
        timeoutMs: 300,
      });
      const v = await rebinding.vet("http://rebind.example.com/");
      expect(v.address).toBe("93.184.216.34");
      expect(calls).toBe(1); // vet resolves once; the connection reuses v.address instead of looking up again
    });
  });
});
