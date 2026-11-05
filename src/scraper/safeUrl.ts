import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * SSRF defence for the scraper: a user-supplied URL must never make the server fetch from its own
 * network (localhost, private ranges, cloud metadata addresses).
 *
 * Every hop of a redirect chain is checked again by the caller, because a public site can redirect to
 * an internal address.
 */

// Two lists: Node matches an IPv4 address against IPv6 rules too (as ::ffff:a.b.c.d), so a ::ffff:0:0/96
// rule in a shared list would block every public IPv4 address.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked4.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked6.addSubnet(net, prefix, "ipv6");

const LOOPBACK_V4 = new BlockList();
LOOPBACK_V4.addSubnet("127.0.0.0", 8, "ipv4");

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

export interface SafeUrlOptions {
  /** Allow http://127.x/demo/... (only the bundled demo pages). Never enable in production. */
  allowLoopback?: boolean;
  lookup?: Lookup;
}

export type SafeUrlResult = { ok: true; url: URL } | { ok: false; reason: string };

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true });

function isBlockedAddress(address: string, family: number): boolean {
  return family === 6 ? blocked6.check(address, "ipv6") : blocked4.check(address, "ipv4");
}

export async function checkUrl(value: string, opts: SafeUrlOptions = {}): Promise<SafeUrlResult> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "That is not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "Only http and https addresses can be scraped" };
  if (url.username || url.password) return { ok: false, reason: "Addresses with a username or password are not allowed" };

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, ""); // "localhost." is localhost
  if (!host) return { ok: false, reason: "That is not a valid URL" };

  const literal = isIP(host);
  const isNamedLocal = host === "localhost" || host.endsWith(".localhost");

  // The bundled demo pages live on this very server, so loopback is allowed for exactly that path.
  if (opts.allowLoopback && url.pathname.startsWith("/demo/") && (isNamedLocal || (literal === 4 && LOOPBACK_V4.check(host, "ipv4")))) {
    return { ok: true, url };
  }

  if (isNamedLocal || host.endsWith(".local") || host.endsWith(".internal")) return { ok: false, reason: "Local addresses cannot be scraped" };

  if (literal) {
    if (isBlockedAddress(host, literal)) return { ok: false, reason: "Private or local addresses cannot be scraped" };
    if (!ALLOWED_PORTS.has(url.port)) return { ok: false, reason: "That port is not allowed" };
    return { ok: true, url };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await (opts.lookup ?? defaultLookup)(host);
  } catch {
    return { ok: false, reason: "That website's address could not be found" };
  }
  if (addresses.length === 0) return { ok: false, reason: "That website's address could not be found" };
  if (addresses.some((a) => isBlockedAddress(a.address, a.family))) return { ok: false, reason: "Private or local addresses cannot be scraped" };
  if (!ALLOWED_PORTS.has(url.port)) return { ok: false, reason: "That port is not allowed" };
  return { ok: true, url };
}
