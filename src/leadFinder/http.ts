import { SourceBlockedError, type SourceContext } from "./types";

export const FINDER_USER_AGENT = "ApexOutboxLeadFinder/1.0 (finds public job requests; contact the account owner)";

interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  minIntervalMs?: number;
  maxBytes?: number;
  cacheTtlMs?: number;
  /** Test hook. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One instance per worker. Every source goes through it, so the hygiene rules live in one place:
 * a timeout, at most `retries` retries with exponential backoff for network errors and 5xx, a minimum
 * gap between requests to the same host, a response size cap, and a short cache for identical requests.
 * 401/403/429 are not retried: they mean the site does not want us, which is reported as "blocked".
 */
export function createHttp(opts: HttpOptions = {}): SourceContext {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const retries = opts.retries ?? 2;
  const minInterval = opts.minIntervalMs ?? 1_000;
  const maxBytes = opts.maxBytes ?? 3_000_000;
  const ttl = opts.cacheTtlMs ?? 10 * 60_000;
  const sleep = opts.sleep ?? realSleep;
  const doFetch = opts.fetchImpl ?? fetch;
  const lastHit = new Map<string, number>();
  const cache = new Map<string, { at: number; body: string }>();

  async function once(url: string, headers: Record<string, string>): Promise<string> {
    const host = new URL(url).host;
    const wait = (lastHit.get(host) ?? 0) + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { headers: { "user-agent": FINDER_USER_AGENT, accept: "application/json, application/rss+xml, text/xml, */*", ...headers }, signal: ctrl.signal, redirect: "follow" });
      if (res.status === 401 || res.status === 403 || res.status === 429) throw new SourceBlockedError(`${host} refused automated access (HTTP ${res.status})`);
      if (res.status >= 500) throw new Error(`${host} answered HTTP ${res.status}`);
      if (!res.ok) throw new Error(`${host} answered HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new Error("response too large");
      const text = await res.text();
      if (text.length > maxBytes) throw new Error("response too large");
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async get(url, o = {}) {
      const key = `${url}|${JSON.stringify(o.headers ?? {})}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttl) return hit.body;

      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const body = await once(url, o.headers ?? {});
          cache.set(key, { at: Date.now(), body });
          if (cache.size > 200) cache.delete(cache.keys().next().value as string);
          return body;
        } catch (error) {
          if (error instanceof SourceBlockedError) throw error;
          lastError = error;
          if (attempt < retries) await sleep(500 * 2 ** attempt);
        }
      }
      const msg = lastError instanceof Error && lastError.name === "AbortError" ? "the site did not answer in time" : lastError instanceof Error ? lastError.message : "request failed";
      throw new Error(msg);
    },
  };
}
