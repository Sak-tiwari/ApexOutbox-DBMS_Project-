import { writeAudit } from "../audit.js";
import { withTenant, type Db, type Tx } from "../db/pool.js";
import { normalizeDomain } from "../domain/normalize.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { cursorTs, decodeCursor, encodeCursor } from "../http/pagination.js";
import type { AuthContext } from "../middleware/auth.js";
import { BlockedTargetError, checkUrlShape, hostAllowed } from "./ssrf.js";

export const MAX_URLS_PER_JOB = 20;
export const MAX_ACTIVE_JOBS = 3;

export interface JobView {
  id: string;
  adapter: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  urls: string[];
  cancelRequested: boolean;
  pagesTotal: number;
  pagesDone: number;
  found: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  errors: { url: string; message: string }[];
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface JobRow {
  id: string; adapter: string; status: JobView["status"]; params: { urls?: string[] }; cancel_requested: boolean;
  pages_total: number; pages_done: number; found: number; inserted: number; duplicates: number; rejected: number;
  errors: JobView["errors"]; created_by: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null; cursor_t?: string;
}
const JOB_COLUMNS = `id, adapter, status, params, cancel_requested, pages_total, pages_done, found, inserted, duplicates, rejected,
  errors, created_by, created_at, started_at, finished_at`;

const jobView = (r: JobRow): JobView => ({
  id: r.id, adapter: r.adapter, status: r.status, urls: r.params.urls ?? [], cancelRequested: r.cancel_requested,
  pagesTotal: r.pages_total, pagesDone: r.pages_done, found: r.found, inserted: r.inserted, duplicates: r.duplicates,
  rejected: r.rejected, errors: r.errors, createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  startedAt: r.started_at?.toISOString() ?? null, finishedAt: r.finished_at?.toISOString() ?? null,
});

/** Turns "https://www.Acme.com/path" or "acme.com" into the bare domain "acme.com", or throws. */
export function parseDomainInput(raw: string): string {
  const domain = normalizeDomain(raw);
  if (!domain || !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) throw new ValidationError("Enter a domain like example.com", undefined, "INVALID_DOMAIN");
  try {
    checkUrlShape(`https://${domain}/`);
  } catch (err) {
    if (err instanceof BlockedTargetError) throw new ValidationError(err.message, undefined, "INVALID_DOMAIN");
    throw err;
  }
  return domain;
}

export class ScrapeService {
  constructor(private readonly db: Db) {}

  // -- allowlist ---------------------------------------------------------------------------

  async listDomains(actor: AuthContext) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string; domain: string; created_at: Date }>(
        "SELECT id, domain, created_at FROM scrape_allowed_domains WHERE tenant_id = $1 ORDER BY domain",
        [actor.tenantId],
      );
      return { items: rows.map((r) => ({ id: r.id, domain: r.domain, createdAt: r.created_at.toISOString() })) };
    });
  }

  async addDomain(actor: AuthContext, raw: string, ip?: string) {
    const domain = parseDomainInput(raw);
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO scrape_allowed_domains (tenant_id, domain, created_by) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, domain) DO NOTHING RETURNING id, created_at`,
        [actor.tenantId, domain, actor.userId],
      );
      if (!rows[0]) throw new ConflictError("That domain is already on the list", "DOMAIN_EXISTS");
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "scrape.domain_added", entityType: "scrape_domain", entityId: rows[0].id, metadata: { domain }, ip });
      return { id: rows[0].id, domain, createdAt: rows[0].created_at.toISOString() };
    });
  }

  async removeDomain(actor: AuthContext, id: string, ip?: string) {
    await withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ domain: string }>("DELETE FROM scrape_allowed_domains WHERE tenant_id = $1 AND id = $2 RETURNING domain", [actor.tenantId, id]);
      if (!rows[0]) throw new NotFoundError("Domain not found");
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "scrape.domain_removed", entityType: "scrape_domain", entityId: id, metadata: { domain: rows[0].domain }, ip });
    });
  }

  // -- jobs --------------------------------------------------------------------------------

  async createJob(actor: AuthContext, input: { urls: string[]; idempotencyKey?: string }, ip?: string): Promise<{ job: JobView; created: boolean }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertEnabled(tx, actor.tenantId);

      if (input.idempotencyKey) {
        const existing = await tx.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM scrape_jobs WHERE tenant_id = $1 AND idempotency_key = $2`, [actor.tenantId, input.idempotencyKey]);
        if (existing.rows[0]) return { job: jobView(existing.rows[0]), created: false };
      }

      const allowed = (await tx.query<{ domain: string }>("SELECT domain FROM scrape_allowed_domains WHERE tenant_id = $1", [actor.tenantId])).rows.map((r) => r.domain);
      const urls = input.urls.map((u) => u.trim());
      const problems: { url: string; message: string }[] = [];
      const normalized: string[] = [];
      for (const raw of urls) {
        try {
          const url = checkUrlShape(raw);
          if (!hostAllowed(url.hostname, allowed)) throw new BlockedTargetError("Domain is not on your approved list. Add it first.");
          url.hash = "";
          normalized.push(url.toString());
        } catch (err) {
          if (!(err instanceof BlockedTargetError)) throw err;
          problems.push({ url: raw.slice(0, 200), message: err.message });
        }
      }
      if (problems.length) throw new ValidationError("Some URLs cannot be scraped", problems, "URL_NOT_ALLOWED");
      const unique = [...new Set(normalized)]; // after fragment stripping, so /page and /page#top count once

      const active = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM scrape_jobs WHERE tenant_id = $1 AND status IN ('QUEUED', 'RUNNING')", [actor.tenantId]);
      if (active.rows[0]!.n >= MAX_ACTIVE_JOBS) throw new ConflictError(`You already have ${MAX_ACTIVE_JOBS} scrape jobs running. Wait for one to finish.`, "TOO_MANY_JOBS");

      const { rows } = await tx.query<JobRow>(
        `INSERT INTO scrape_jobs (tenant_id, created_by, adapter, params, pages_total, idempotency_key)
         VALUES ($1, $2, 'generic-html', $3, $4, $5) RETURNING ${JOB_COLUMNS}`,
        [actor.tenantId, actor.userId, JSON.stringify({ urls: unique }), unique.length, input.idempotencyKey ?? null],
      );
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "scrape.job_created", entityType: "scrape_job", entityId: rows[0]!.id, metadata: { urls: unique.length }, ip });
      return { job: jobView(rows[0]!), created: true };
    });
  }

  async listJobs(actor: AuthContext, params: { limit: number; cursor?: string }) {
    const cursor = decodeCursor(params.cursor);
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<JobRow>(
        `SELECT ${JOB_COLUMNS}, ${cursorTs("created_at")} AS cursor_t FROM scrape_jobs
          WHERE tenant_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $4`,
        [actor.tenantId, cursor?.t ?? null, cursor?.id ?? null, params.limit + 1],
      );
      const page = rows.slice(0, params.limit);
      const last = page[page.length - 1];
      return { items: page.map(jobView), nextCursor: rows.length > params.limit && last ? encodeCursor({ t: last.cursor_t!, id: last.id }) : null };
    });
  }

  async getJob(actor: AuthContext, id: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM scrape_jobs WHERE tenant_id = $1 AND id = $2`, [actor.tenantId, id]);
      if (!rows[0]) throw new NotFoundError("Scrape job not found");
      return jobView(rows[0]);
    });
  }

  /** QUEUED jobs stop immediately; RUNNING jobs finish the page in flight and then stop. */
  async cancelJob(actor: AuthContext, id: string, ip?: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<JobRow>(
        `UPDATE scrape_jobs
            SET cancel_requested = true,
                status = CASE WHEN status = 'QUEUED' THEN 'CANCELLED' ELSE status END,
                finished_at = CASE WHEN status = 'QUEUED' THEN now() ELSE finished_at END
          WHERE tenant_id = $1 AND id = $2 AND status IN ('QUEUED', 'RUNNING')
          RETURNING ${JOB_COLUMNS}`,
        [actor.tenantId, id],
      );
      if (!rows[0]) {
        const exists = await tx.query("SELECT 1 FROM scrape_jobs WHERE tenant_id = $1 AND id = $2", [actor.tenantId, id]);
        if (!exists.rows[0]) throw new NotFoundError("Scrape job not found");
        throw new ConflictError("This job has already finished", "JOB_FINISHED");
      }
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "scrape.job_cancelled", entityType: "scrape_job", entityId: id, ip });
      return jobView(rows[0]);
    });
  }

  private async assertEnabled(tx: Tx, tenantId: string) {
    const { rows } = await tx.query<{ settings: { features?: { scraper?: boolean } } }>("SELECT settings FROM tenants WHERE id = $1", [tenantId]);
    if (rows[0]?.settings?.features?.scraper === false) throw new ForbiddenError("Lead scraping is turned off for this workspace", "FEATURE_DISABLED");
  }
}
