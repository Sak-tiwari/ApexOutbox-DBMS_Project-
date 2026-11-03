import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** True when the address must never be contacted by the scraper (private, loopback, link-local, metadata, ...). */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return blockedV4(ip);
  if (kind === 6) return blockedV6(ip.toLowerCase());
  return true; // not an IP at all: refuse
}

function blockedV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local incl. cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands any IPv6 text form into 8 numeric groups. */
function groupsV6(ip: string): number[] | null {
  let s = ip.split("%")[0]!; // drop zone id
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4[1]!.split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    s = s.slice(0, -v4[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

function blockedV6(ip: string): boolean {
  const g = groupsV6(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every((x) => x === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96): judge by the embedded IPv4.
  const embedded = `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return blockedV4(embedded);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return blockedV4(embedded);
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2002) return blockedV4(`${g1 >> 8}.${g1 & 255}.${g2 >> 8}.${g2 & 255}`); // 6to4
  return false;
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;

export const systemResolver: Resolver = async (hostname) => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
};

export class BlockedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedTargetError";
  }
}

const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".intranet", ".lan", ".home", ".corp", ".arpa"];

/** Syntactic checks that need no DNS. Throws BlockedTargetError. Returns the parsed URL. */
export function checkUrlShape(raw: string, options: { allowedPorts?: number[] } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError("Not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedTargetError("Only http and https URLs are allowed");
  if (url.username || url.password) throw new BlockedTargetError("URLs with credentials are not allowed");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new BlockedTargetError("URL has no host");
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) throw new BlockedTargetError("IP addresses are not allowed, use a domain name");
  if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) throw new BlockedTargetError("Numeric hosts are not allowed");
  if (host === "localhost" || !host.includes(".") || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BlockedTargetError("Internal host names are not allowed");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!(options.allowedPorts ?? [80, 443]).includes(port)) throw new BlockedTargetError("Port not allowed");
  return url;
}

/**
 * Resolves a host and refuses it if ANY address is non-public. Returns the one address to connect to;
 * the caller must connect to exactly that address (pinning), otherwise a second DNS lookup could return
 * a different, internal answer (DNS rebinding).
 */
export async function resolvePublic(hostname: string, resolver: Resolver = systemResolver, blocked: (ip: string) => boolean = isBlockedIp) {
  let rows: Awaited<ReturnType<Resolver>>;
  try {
    rows = await resolver(hostname);
  } catch {
    throw new BlockedTargetError("Host could not be resolved");
  }
  if (rows.length === 0) throw new BlockedTargetError("Host could not be resolved");
  if (rows.some((r) => blocked(r.address))) throw new BlockedTargetError("Host resolves to a non-public address");
  return rows[0]!;
}

/** `host` equals an allowed domain or is a subdomain of one ("shop.acme.com" is allowed by "acme.com"). */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((d) => h === d || h.endsWith(`.${d}`));
}
