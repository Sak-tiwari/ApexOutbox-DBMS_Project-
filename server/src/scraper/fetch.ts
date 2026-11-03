import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { BlockedTargetError, checkUrlShape, hostAllowed, isBlockedIp, resolvePublic, systemResolver, type Resolver } from "./ssrf.js";

export const USER_AGENT = "ApexOutboxBot/1.0 (+lead research; respects robots.txt)";

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

export interface SafeFetcherOptions {
  /** Domains the workspace has approved. Checked on every request AND every redirect hop. */
  allowedDomains: () => readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Test seams. Production always uses the defaults, which refuse every non-public address. */
  resolver?: Resolver;
  isBlocked?: (ip: string) => boolean;
  allowedPorts?: number[];
}

export class FetchError extends Error {
  constructor(message: string, public readonly kind: "blocked" | "network" | "http" | "content" = "network") {
    super(message);
    this.name = "FetchError";
  }
}

const TEXT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i;

/**
 * Fetches a public web page without ever touching an internal network.
 *  - only http(s) on ports 80/443, no credentials, no IP literals or internal-looking host names
 *  - the host must be on the workspace allowlist (again after every redirect)
 *  - DNS is resolved once, ALL answers must be public, and the socket is pinned to that answer
 *    (a second lookup cannot be steered to 127.0.0.1 by DNS rebinding)
 *  - redirects are followed manually (max 3) and each hop goes through the same checks
 *  - response size and time are capped; only text content types are read
 */
export class SafeFetcher {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly resolver: Resolver;
  private readonly isBlocked: (ip: string) => boolean;

  constructor(private readonly options: SafeFetcherOptions) {
    this.maxBytes = options.maxBytes ?? 1_000_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.resolver = options.resolver ?? systemResolver;
    this.isBlocked = options.isBlocked ?? isBlockedIp;
  }

  /** Throws FetchError("blocked") unless the URL is allowed. Does not touch the network except DNS. */
  async vet(raw: string): Promise<{ url: URL; address: string; family: 4 | 6 }> {
    try {
      const url = checkUrlShape(raw, { allowedPorts: this.options.allowedPorts });
      if (!hostAllowed(url.hostname, this.options.allowedDomains())) throw new BlockedTargetError("Domain is not on your approved list");
      const target = await resolvePublic(url.hostname, this.resolver, this.isBlocked);
      return { url, address: target.address, family: target.family };
    } catch (err) {
      if (err instanceof BlockedTargetError) throw new FetchError(err.message, "blocked");
      throw err;
    }
  }

  async fetch(raw: string): Promise<FetchedPage> {
    let current = raw;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      const { url, address, family } = await this.vet(current);
      const res = await this.once(url, address, family);
      if (res.status >= 300 && res.status < 400 && res.location) {
        let next: string;
        try {
          next = new URL(res.location, url).toString();
        } catch {
          throw new FetchError("Bad redirect target", "http");
        }
        current = next;
        continue;
      }
      return { url: url.toString(), status: res.status, contentType: res.contentType, body: res.body, truncated: res.truncated };
    }
    throw new FetchError("Too many redirects", "http");
  }

  private once(url: URL, address: string, family: 4 | 6) {
    return new Promise<{ status: number; location?: string; contentType: string; body: string; truncated: boolean }>((resolve, reject) => {
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      // Connect to the address we already vetted, whatever the system resolver would say now.
      const pinned: LookupFunction = (_host, opts, cb) => {
        if (opts && (opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
        else cb(null, address, family);
      };
      let settled = false;
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fn();
        }
      };
      const req = send(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          lookup: pinned,
          servername: url.hostname, // TLS SNI + certificate check use the real host name
          headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9", "accept-encoding": "identity" },
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const contentType = String(res.headers["content-type"] ?? "");
          const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
          if (status >= 300 && status < 400) {
            res.resume();
            return done(() => resolve({ status, location, contentType, body: "", truncated: false }));
          }
          if (!TEXT_TYPES.test(contentType) && status < 400 && status !== 204) {
            res.destroy();
            return done(() => reject(new FetchError(`Unsupported content type: ${contentType.split(";")[0] || "unknown"}`, "content")));
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > this.maxBytes * 4) {
            res.destroy();
            return done(() => reject(new FetchError("Response too large", "content")));
          }
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > this.maxBytes) {
              truncated = true;
              chunks.push(c.subarray(0, c.length - (size - this.maxBytes)));
              res.destroy();
              return;
            }
            chunks.push(c);
          });
          const finish = () => done(() => resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8"), truncated }));
          res.on("end", finish);
          res.on("close", finish);
          res.on("error", (e) => done(() => (truncated ? finish() : reject(new FetchError(e.message)))));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        done(() => reject(new FetchError("Timed out")));
      }, this.timeoutMs);
      req.on("error", (e) => done(() => reject(new FetchError(`Network error: ${(e as NodeJS.ErrnoException).code ?? e.message}`))));
      req.end();
    });
  }
}
