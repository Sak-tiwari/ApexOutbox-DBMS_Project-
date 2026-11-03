import { writeAudit } from "../audit.js";
import { withTenant, type Db, type Tx } from "../db/pool.js";
import { buildDedupeKey } from "../domain/normalize.js";
import { allowedNext, evaluateTransition, type LeadStatus } from "../domain/pipeline.js";
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from "../errors.js";
import { cursorTs, decodeCursor, encodeCursor } from "../http/pagination.js";
import type { AuthContext } from "../middleware/auth.js";
import type { ImportRow, RowError } from "./csv.js";

export interface LeadView {
  id: string;
  name: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  needsReview: boolean;
  status: LeadStatus;
  version: number;
  ownerId: string | null;
  followUpAt: string | null;
  sourceAdapter: string;
  sourceUrl: string | null;
  scrapedAt: string | null;
  scrapeJobId: string | null;
  clientId: string | null;
  createdAt: string;
  updatedAt: string;
  allowedNext: readonly LeadStatus[];
}

interface Row {
  id: string; name: string; company_name: string | null; email: string | null; phone: string | null; website: string | null;
  needs_review: boolean; status: LeadStatus; version: number; owner_id: string | null; follow_up_at: Date | null;
  source_adapter: string; source_url: string | null; scraped_at: Date | null; scrape_job_id: string | null; client_id: string | null;
  created_at: Date; updated_at: Date; cursor_t?: string;
}

const COLUMNS = `id, name, company_name, email, phone, website, needs_review, status, version, owner_id, follow_up_at,
  source_adapter, source_url, scraped_at, scrape_job_id, client_id, created_at, updated_at`;

export const leadView = (r: Row): LeadView => ({
  id: r.id,
  name: r.name,
  companyName: r.company_name,
  email: r.email,
  phone: r.phone,
  website: r.website,
  needsReview: r.needs_review,
  status: r.status,
  version: r.version,
  ownerId: r.owner_id,
  followUpAt: r.follow_up_at?.toISOString() ?? null,
  sourceAdapter: r.source_adapter,
  sourceUrl: r.source_url,
  scrapedAt: r.scraped_at?.toISOString() ?? null,
  scrapeJobId: r.scrape_job_id,
  clientId: r.client_id,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  allowedNext: allowedNext(r.status),
});

export interface LeadFilters {
  limit: number;
  cursor?: string;
  q?: string;
  status?: LeadStatus[];
  ownerId?: string;
  unowned?: boolean;
  needsReview?: boolean;
  followUpDue?: boolean;
}

export interface LeadInput {
  name: string;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  ownerId?: string | null;
  followUpAt?: string | null;
}

/** Escapes LIKE wildcards so a search for "100%" or "a_b" is literal. */
export const likePattern = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;

const isAdminRole = (a: AuthContext) => a.role === "OWNER" || a.role === "ADMIN";

/**
 * Members may change leads they own or that nobody owns yet; admins and owners may change any lead.
 * (Reading is open to every member of the tenant.)
 */
function assertCanWrite(actor: AuthContext, lead: Pick<Row, "owner_id">) {
  if (isAdminRole(actor) || lead.owner_id === null || lead.owner_id === actor.userId) return;
  throw new ForbiddenError("Only the lead owner or an admin can change this lead", "NOT_LEAD_OWNER");
}

export class LeadsService {
  constructor(private readonly db: Db) {}

  async list(actor: AuthContext, f: LeadFilters) {
    const cursor = decodeCursor(f.cursor);
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<Row>(
        `SELECT ${COLUMNS}, ${cursorTs("updated_at")} AS cursor_t
           FROM leads
          WHERE tenant_id = $1 AND deleted_at IS NULL
            AND ($2::timestamptz IS NULL OR (updated_at, id) < ($2::timestamptz, $3::uuid))
            AND ($4::text IS NULL OR search_text LIKE $4 ESCAPE '\\')
            AND ($5::text[] IS NULL OR status = ANY($5))
            AND ($6::uuid IS NULL OR owner_id = $6)
            AND ($7::boolean IS NOT TRUE OR owner_id IS NULL)
            AND ($8::boolean IS NULL OR needs_review = $8)
            AND ($9::boolean IS NOT TRUE OR (follow_up_at IS NOT NULL AND follow_up_at <= now() AND status NOT IN ('CLOSED_WON', 'CLOSED_LOST')))
          ORDER BY updated_at DESC, id DESC
          LIMIT $10`,
        [
          actor.tenantId,
          cursor?.t ?? null,
          cursor?.id ?? null,
          f.q ? likePattern(f.q) : null,
          f.status?.length ? f.status : null,
          f.ownerId ?? null,
          f.unowned ?? null,
          f.needsReview ?? null,
          f.followUpDue ?? null,
          f.limit + 1,
        ],
      );
      const page = rows.slice(0, f.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(leadView),
        nextCursor: rows.length > f.limit && last ? encodeCursor({ t: last.cursor_t!, id: last.id }) : null,
      };
    });
  }

  /** Counts per pipeline stage for the dashboard and board column headers. */
  async stats(actor: AuthContext) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ status: LeadStatus; n: number; review: number; due: number }>(
        `SELECT status, count(*)::int AS n,
                count(*) FILTER (WHERE needs_review)::int AS review,
                count(*) FILTER (WHERE follow_up_at <= now() AND status NOT IN ('CLOSED_WON','CLOSED_LOST'))::int AS due
           FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL GROUP BY status`,
        [actor.tenantId],
      );
      const byStatus: Record<string, number> = { NEW: 0, CONTACTED: 0, FOLLOW_UP: 0, NEGOTIATION: 0, CLOSED_WON: 0, CLOSED_LOST: 0 };
      let total = 0, needsReview = 0, followUpDue = 0;
      for (const r of rows) {
        byStatus[r.status] = r.n;
        total += r.n;
        needsReview += r.review;
        followUpDue += r.due;
      }
      return { total, byStatus, needsReview, followUpDue };
    });
  }

  async get(actor: AuthContext, id: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const lead = await this.find(tx, actor.tenantId, id);
      const history = await tx.query<{
        id: string; type: string; from_status: string | null; to_status: string | null; reason: string | null;
        actor_id: string | null; actor_type: string; at: Date;
      }>(
        `SELECT id, type, from_status, to_status, reason, actor_id, actor_type, at
           FROM activities WHERE tenant_id = $1 AND lead_id = $2 ORDER BY at DESC, id DESC LIMIT 200`,
        [actor.tenantId, id],
      );
      return {
        lead: leadView(lead),
        activities: history.rows.map((a) => ({
          id: a.id, type: a.type, fromStatus: a.from_status, toStatus: a.to_status, reason: a.reason,
          actorId: a.actor_id, actorType: a.actor_type, at: a.at.toISOString(),
        })),
      };
    });
  }

  async create(actor: AuthContext, input: LeadInput, ip?: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const ownerId = await this.resolveOwner(tx, actor, input.ownerId, undefined);
      const dedupeKey = buildDedupeKey(input);
      const { rows } = await tx.query<Row & { dup?: boolean }>(
        `INSERT INTO leads (tenant_id, name, company_name, email, phone, website, dedupe_key, needs_review, owner_id, follow_up_at, source_adapter)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual')
         ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND deleted_at IS NULL DO NOTHING
         RETURNING ${COLUMNS}`,
        [actor.tenantId, input.name, input.companyName ?? null, input.email ?? null, input.phone ?? null, input.website ?? null,
         dedupeKey, dedupeKey === null, ownerId, input.followUpAt ?? null],
      );
      const created = rows[0];
      if (!created) {
        const existing = await tx.query<{ id: string }>(
          "SELECT id FROM leads WHERE tenant_id = $1 AND dedupe_key = $2 AND deleted_at IS NULL",
          [actor.tenantId, dedupeKey],
        );
        throw new ConflictError("A lead for this business already exists", "DUPLICATE_LEAD", { existingId: existing.rows[0]?.id });
      }
      await tx.query(
        "INSERT INTO activities (tenant_id, lead_id, type, to_status, actor_id) VALUES ($1, $2, 'CREATED', 'NEW', $3)",
        [actor.tenantId, created.id, actor.userId],
      );
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "lead.created", entityType: "lead", entityId: created.id, ip });
      return leadView(created);
    });
  }

  async update(actor: AuthContext, id: string, patch: Partial<LeadInput> & { version: number }, ip?: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const current = await this.find(tx, actor.tenantId, id, true);
      assertCanWrite(actor, current);
      this.assertVersion(current, patch.version);

      const next = {
        name: patch.name ?? current.name,
        company_name: patch.companyName !== undefined ? patch.companyName : current.company_name,
        email: patch.email !== undefined ? patch.email : current.email,
        phone: patch.phone !== undefined ? patch.phone : current.phone,
        website: patch.website !== undefined ? patch.website : current.website,
        follow_up_at: patch.followUpAt !== undefined ? patch.followUpAt : current.follow_up_at,
      };
      const ownerId = patch.ownerId !== undefined ? await this.resolveOwner(tx, actor, patch.ownerId, current) : current.owner_id;
      const dedupeKey = buildDedupeKey({ website: next.website, email: next.email, phone: next.phone });
      try {
        const { rows } = await tx.query<Row>(
          `UPDATE leads SET name = $3, company_name = $4, email = $5, phone = $6, website = $7, follow_up_at = $8,
                  owner_id = $9, dedupe_key = $10, needs_review = $11, version = version + 1
            WHERE tenant_id = $1 AND id = $2 AND version = $12 AND deleted_at IS NULL
            RETURNING ${COLUMNS}`,
          [actor.tenantId, id, next.name, next.company_name, next.email, next.phone, next.website, next.follow_up_at,
           ownerId, dedupeKey, dedupeKey === null, patch.version],
        );
        const updated = rows[0];
        if (!updated) throw await this.versionConflict(tx, actor.tenantId, id);
        if (ownerId !== current.owner_id) {
          await tx.query(
            "INSERT INTO activities (tenant_id, lead_id, type, reason, actor_id) VALUES ($1, $2, 'OWNER_CHANGED', $3, $4)",
            [actor.tenantId, id, ownerId ? `Assigned to ${ownerId}` : "Unassigned", actor.userId],
          );
        }
        await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "lead.updated", entityType: "lead", entityId: id, ip });
        return leadView(updated);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictError("Another lead already uses this website, e-mail or phone", "DUPLICATE_LEAD");
        }
        throw err;
      }
    });
  }

  async transition(actor: AuthContext, id: string, input: { to: LeadStatus; version: number; reason?: string }, ip?: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const current = await this.find(tx, actor.tenantId, id, true);
      assertCanWrite(actor, current);
      this.assertVersion(current, input.version);

      const verdict = evaluateTransition({ from: current.status, to: input.to, reason: input.reason });
      if (!verdict.ok) {
        throw new UnprocessableError(verdict.message, verdict.code === "REASON_REQUIRED" ? "REASON_REQUIRED" : verdict.code === "SAME_STATE" ? "SAME_STATE" : "INVALID_TRANSITION", {
          from: current.status, to: input.to, allowedNext: allowedNext(current.status),
        });
      }
      if (verdict.sideEffects.includes("CREATE_CLIENT_AND_OUTBOX_EVENT")) {
        // Wired up in stage 4 (client + invoice + e-mail in one transaction).
        throw new UnprocessableError("Closing a lead as won needs deal details", "CLOSED_WON_UNAVAILABLE");
      }

      const { rows } = await tx.query<Row>(
        `UPDATE leads SET status = $3, version = version + 1
          WHERE tenant_id = $1 AND id = $2 AND version = $4 AND status = $5 AND deleted_at IS NULL
          RETURNING ${COLUMNS}`,
        [actor.tenantId, id, input.to, input.version, current.status],
      );
      const updated = rows[0];
      if (!updated) throw await this.versionConflict(tx, actor.tenantId, id);
      await tx.query(
        `INSERT INTO activities (tenant_id, lead_id, type, from_status, to_status, reason, actor_id)
         VALUES ($1, $2, 'STATUS_CHANGED', $3, $4, $5, $6)`,
        [actor.tenantId, id, current.status, input.to, input.reason?.trim() || null, actor.userId],
      );
      await writeAudit(tx, {
        tenantId: actor.tenantId, actorId: actor.userId, action: verdict.kind === "reopen" ? "lead.reopened" : "lead.status_changed",
        entityType: "lead", entityId: id, metadata: { from: current.status, to: input.to }, ip,
      });
      return leadView(updated);
    });
  }

  async addNote(actor: AuthContext, id: string, note: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const current = await this.find(tx, actor.tenantId, id);
      assertCanWrite(actor, current);
      await tx.query("INSERT INTO activities (tenant_id, lead_id, type, reason, actor_id) VALUES ($1, $2, 'NOTE', $3, $4)", [actor.tenantId, id, note, actor.userId]);
    });
  }

  async remove(actor: AuthContext, id: string, ip?: string) {
    await withTenant(this.db, actor.tenantId, async (tx) => {
      const current = await this.find(tx, actor.tenantId, id, true);
      if (current.status === "CLOSED_WON" || current.client_id) {
        throw new UnprocessableError("A won lead has a client and invoices and cannot be deleted", "LEAD_HAS_CLIENT");
      }
      // Frees the dedupe key so the same business can be added again later.
      await tx.query("UPDATE leads SET deleted_at = now(), dedupe_key = NULL, version = version + 1 WHERE tenant_id = $1 AND id = $2", [actor.tenantId, id]);
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "lead.deleted", entityType: "lead", entityId: id, ip });
    });
  }

  /** Inserts validated CSV rows in one transaction. Duplicates are skipped, never overwritten. */
  async importRows(actor: AuthContext, rows: { line: number; data: ImportRow }[], rejected: RowError[], ip?: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      let inserted = 0;
      let duplicates = 0;
      const errors = [...rejected];
      for (const { line, data } of rows) {
        const res = await tx.query<{ id: string }>(
          `INSERT INTO leads (tenant_id, name, company_name, email, phone, website, dedupe_key, needs_review, owner_id, source_adapter)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'csv')
           ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND deleted_at IS NULL DO NOTHING
           RETURNING id`,
          [actor.tenantId, data.name, data.companyName, data.email, data.phone, data.website, data.dedupeKey, data.dedupeKey === null, actor.userId],
        );
        if (!res.rows[0]) {
          duplicates++;
          errors.push({ row: line, message: "Duplicate: a lead for this business already exists" });
          continue;
        }
        inserted++;
        await tx.query(
          "INSERT INTO activities (tenant_id, lead_id, type, to_status, reason, actor_id) VALUES ($1, $2, 'IMPORTED', 'NEW', 'CSV import', $3)",
          [actor.tenantId, res.rows[0].id, actor.userId],
        );
      }
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "lead.csv_imported", metadata: { inserted, duplicates, rejected: rejected.length }, ip });
      errors.sort((a, b) => a.row - b.row);
      return { total: rows.length + rejected.length, inserted, duplicates, rejected: rejected.length, errors: errors.slice(0, 50), moreErrors: Math.max(0, errors.length - 50) };
    });
  }

  // -- helpers -------------------------------------------------------------------------------

  private async find(tx: Tx, tenantId: string, id: string, lock = false): Promise<Row> {
    const { rows } = await tx.query<Row>(
      `SELECT ${COLUMNS} FROM leads WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`,
      [tenantId, id],
    );
    if (!rows[0]) throw new NotFoundError("Lead not found");
    return rows[0];
  }

  private assertVersion(current: Row, expected: number) {
    if (current.version !== expected) {
      throw new ConflictError("This lead was changed by someone else. Refresh and try again.", "VERSION_CONFLICT", {
        currentVersion: current.version, currentStatus: current.status,
      });
    }
  }

  private async versionConflict(tx: Tx, tenantId: string, id: string) {
    const { rows } = await tx.query<{ version: number; status: string }>("SELECT version, status FROM leads WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL", [tenantId, id]);
    if (!rows[0]) return new NotFoundError("Lead not found");
    return new ConflictError("This lead was changed by someone else. Refresh and try again.", "VERSION_CONFLICT", {
      currentVersion: rows[0].version, currentStatus: rows[0].status,
    });
  }

  /**
   * Who may own a lead. Admins can assign anyone in the workspace; members can only claim an unowned
   * lead for themselves (or create their own). An owner id from another tenant never validates.
   */
  private async resolveOwner(tx: Tx, actor: AuthContext, requested: string | null | undefined, current: Row | undefined): Promise<string | null> {
    if (requested === undefined) return current ? current.owner_id : actor.userId;
    if (requested === null) {
      if (!isAdminRole(actor) && current && current.owner_id !== null) throw new ForbiddenError("Only an admin can unassign a lead", "NOT_LEAD_OWNER");
      return null;
    }
    if (!isAdminRole(actor) && requested !== actor.userId) throw new ForbiddenError("Only an admin can assign leads to other people", "ROLE_NOT_ALLOWED");
    const { rows } = await tx.query("SELECT 1 FROM users WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL", [actor.tenantId, requested]);
    if (!rows[0]) throw new UnprocessableError("That user is not in this workspace", "INVALID_OWNER");
    return requested;
  }
}
