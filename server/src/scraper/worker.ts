import { randomUUID } from "node:crypto";
import { setTimeout as sleepMs } from "node:timers/promises";
import { withTenant, type Db, type Tx } from "../db/pool.js";
import { buildDedupeKey } from "../domain/normalize.js";
import type { Log } from "../logger.js";
import { extractCandidate } from "./extract.js";
import { FetchError, SafeFetcher, USER_AGENT } from "./fetch.js";
import { ALLOW_ALL, DENY_ALL, parseRobots, type Robots } from "./robots.js";

const MAX_STORED_ERRORS = 20;
const MAX_CRAWL_DELAY_MS = 10_000;

export interface WorkerOptions {
  db: Db;
  log: Log;
  /** Minimum pause between two requests to the same host. */
  minDelayMs?: number;
  pollMs?: number;
  staleSeconds?: number;
  workerId?: string;
  /** Test seams. */
  makeFetcher?: (allowedDomains: () => readonly string[]) => Pick<SafeFetcher, "fetch">;
  sleep?: (ms: number) => Promise<void>;
}

interface JobRow {
  id: string;
  params: { urls?: string[] };
  pages_done: number;
  found: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  errors: { url: string; message: string }[];
}

/** Sentence shown to the user. Never includes stack traces, addresses or other internals. */
function publicMessage(err: unknown): string {
  if (err instanceof FetchError) return err.message;
  return "Unexpected error while reading this page";
}

export class ScrapeWorker {
  private readonly db: Db;
  private readonly log: Log;
  private readonly minDelayMs: number;
  private readonly pollMs: number;
  private readonly staleSeconds: number;
  private readonly workerId: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly makeFetcher: NonNullable<WorkerOptions["makeFetcher"]>;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(options: WorkerOptions) {
    this.db = options.db;
    this.log = options.log;
    this.minDelayMs = options.minDelayMs ?? 1500;
    this.pollMs = options.pollMs ?? 2000;
    this.staleSeconds = options.staleSeconds ?? 300;
    this.workerId = options.workerId ?? `scraper-${randomUUID().slice(0, 8)}`;
    this.sleep = options.sleep ?? ((ms) => sleepMs(ms).then(() => undefined));
    this.makeFetcher = options.makeFetcher ?? ((allowed) => new SafeFetcher({ allowedDomains: allowed }));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let worked = false;
        try {
          worked = await this.runOnce();
        } catch (err) {
          this.log.error({ err: (err as Error).message }, "scrape worker loop error");
        }
        if (!worked && this.running) await new Promise<void>((resolve) => { this.wake = resolve; setTimeout(resolve, this.pollMs).unref(); });
      }
    })();
  }

  /** Called after a job is queued so it starts without waiting for the next poll. */
  poke() {
    this.wake?.();
  }

  async stop() {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  /** Claims and fully processes at most one job. Returns false when the queue was empty. */
  async runOnce(): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string; tenant_id: string }>("SELECT id, tenant_id FROM scrape_claim_next($1, $2)", [this.workerId, this.staleSeconds]);
    const claimed = rows[0];
    if (!claimed) return false;
    try {
      await this.process(claimed.tenant_id, claimed.id);
    } catch (err) {
      this.log.error({ err: (err as Error).message, jobId: claimed.id }, "scrape job crashed");
      await withTenant(this.db, claimed.tenant_id, (tx) =>
        tx.query("UPDATE scrape_jobs SET status = 'FAILED', finished_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'RUNNING'", [claimed.tenant_id, claimed.id]),
      );
    }
    return true;
  }

  private async process(tenantId: string, jobId: string) {
    const job = await withTenant(this.db, tenantId, async (tx) => (await tx.query<JobRow>("SELECT id, params, pages_done, found, inserted, duplicates, rejected, errors FROM scrape_jobs WHERE tenant_id = $1 AND id = $2", [tenantId, jobId])).rows[0]);
    if (!job) return;
    const urls = job.params.urls ?? [];
    let allowed: string[] = [];
    const refreshAllowed = () => withTenant(this.db, tenantId, async (tx) => {
      allowed = (await tx.query<{ domain: string }>("SELECT domain FROM scrape_allowed_domains WHERE tenant_id = $1", [tenantId])).rows.map((r) => r.domain);
    });
    await refreshAllowed();
    const fetcher = this.makeFetcher(() => allowed);

    const totals = { found: job.found, inserted: job.inserted, duplicates: job.duplicates, rejected: job.rejected, errors: [...job.errors] };
    const robotsCache = new Map<string, Robots>();
    const lastHit = new Map<string, number>();
    let cancelled = false;

    // Resume after a crash: pages_done already counts finished pages.
    for (let i = job.pages_done; i < urls.length; i++) {
      const cancelFlag = await withTenant(this.db, tenantId, async (tx) => (await tx.query<{ cancel_requested: boolean }>("SELECT cancel_requested FROM scrape_jobs WHERE tenant_id = $1 AND id = $2", [tenantId, jobId])).rows[0]?.cancel_requested);
      if (cancelFlag) { cancelled = true; break; }
      await refreshAllowed(); // a domain removed mid-run stops being fetched

      const pageUrl = urls[i]!;
      const delta = { found: 0, inserted: 0, duplicates: 0, rejected: 0 };
      let error: string | undefined;
      try {
        const host = new URL(pageUrl).host;
        const origin = new URL(pageUrl).origin;
        let robots = robotsCache.get(origin);
        if (!robots) {
          await this.throttle(host, lastHit, undefined);
          robots = await this.loadRobots(fetcher, origin);
          robotsCache.set(origin, robots);
        }
        const target = new URL(pageUrl);
        if (!robots.isAllowed(`${target.pathname}${target.search}`)) {
          delta.rejected++;
          error = "Blocked by the site's robots.txt";
        } else {
          await this.throttle(host, lastHit, robots.crawlDelay);
          const page = await fetcher.fetch(pageUrl);
          if (page.status >= 400) throw new FetchError(`The site answered HTTP ${page.status}`, "http");
          const candidate = extractCandidate(page.body, page.url);
          if (!candidate) {
            delta.rejected++;
            error = "No business name found on this page";
          } else {
            delta.found++;
            const outcome = await withTenant(this.db, tenantId, (tx) => this.saveLead(tx, tenantId, jobId, candidate));
            delta[outcome]++;
          }
        }
      } catch (err) {
        error = publicMessage(err);
        if (!(err instanceof FetchError)) this.log.warn({ err: (err as Error).message, jobId }, "unexpected scrape page error");
      }

      totals.found += delta.found; totals.inserted += delta.inserted; totals.duplicates += delta.duplicates; totals.rejected += delta.rejected;
      if (error && totals.errors.length < MAX_STORED_ERRORS) totals.errors.push({ url: pageUrl.slice(0, 300), message: error });
      await withTenant(this.db, tenantId, (tx) =>
        tx.query(
          `UPDATE scrape_jobs SET pages_done = $3, found = $4, inserted = $5, duplicates = $6, rejected = $7, errors = $8, locked_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, jobId, i + 1, totals.found, totals.inserted, totals.duplicates, totals.rejected, JSON.stringify(totals.errors)],
        ),
      );
    }

    const allFailed = !cancelled && urls.length > 0 && totals.errors.length >= urls.length && totals.inserted + totals.duplicates === 0;
    const status = cancelled ? "CANCELLED" : allFailed ? "FAILED" : "SUCCEEDED";
    await withTenant(this.db, tenantId, (tx) =>
      tx.query("UPDATE scrape_jobs SET status = $3, finished_at = now(), locked_at = NULL, locked_by = NULL WHERE tenant_id = $1 AND id = $2", [tenantId, jobId, status]),
    );
  }

  private async saveLead(tx: Tx, tenantId: string, jobId: string, c: ReturnType<typeof extractCandidate> & object): Promise<"inserted" | "duplicates"> {
    const dedupeKey = buildDedupeKey({ website: c.website, email: c.email, phone: c.phone });
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO leads (tenant_id, name, company_name, email, phone, website, dedupe_key, needs_review, source_adapter, source_url, scraped_at, scrape_job_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'generic-html', $9, now(), $10)
       ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND deleted_at IS NULL DO NOTHING
       RETURNING id`,
      [tenantId, c.name, c.companyName, c.email, c.phone, c.website, dedupeKey, dedupeKey === null, c.sourceUrl, jobId],
    );
    if (!rows[0]) return "duplicates";
    await tx.query(
      "INSERT INTO activities (tenant_id, lead_id, type, to_status, reason, actor_type) VALUES ($1, $2, 'IMPORTED', 'NEW', $3, 'SYSTEM')",
      [tenantId, rows[0].id, `Scraped from ${new URL(c.sourceUrl).host}`],
    );
    return "inserted";
  }

  private async loadRobots(fetcher: Pick<SafeFetcher, "fetch">, origin: string): Promise<Robots> {
    try {
      const res = await fetcher.fetch(`${origin}/robots.txt`);
      if (res.status >= 500) return DENY_ALL; // site is struggling or hiding rules: do not guess
      if (res.status >= 400) return ALLOW_ALL; // no robots.txt = no restrictions (RFC 9309)
      return parseRobots(res.body, USER_AGENT);
    } catch (err) {
      if (err instanceof FetchError && err.kind === "blocked") throw err;
      // Cannot read the rules (timeout, network, non-text): be conservative.
      if (err instanceof FetchError && err.kind === "content") return ALLOW_ALL;
      return DENY_ALL;
    }
  }

  /** At most one request per host per max(minDelay, site's Crawl-delay), capped at 10 s. */
  private async throttle(host: string, lastHit: Map<string, number>, crawlDelaySeconds: number | undefined) {
    const gap = Math.min(MAX_CRAWL_DELAY_MS, Math.max(this.minDelayMs, (crawlDelaySeconds ?? 0) * 1000));
    const last = lastHit.get(host);
    if (last !== undefined) {
      const wait = last + gap - Date.now();
      if (wait > 0) await this.sleep(wait);
    }
    lastHit.set(host, Date.now());
  }
}
