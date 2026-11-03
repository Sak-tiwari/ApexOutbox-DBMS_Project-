import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { assertRlsEffective, withTenant } from "../../src/db/pool.js";
import { appPool, closePools, expectPgError, ownerPool, seedClient, seedLead, seedTenant } from "../helpers/db.js";

afterAll(closePools);

const FK_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

describe("application database role", () => {
  it("cannot bypass Row-Level Security (not superuser, no BYPASSRLS, not a table owner)", async () => {
    await expect(assertRlsEffective(appPool())).resolves.toBeUndefined();
  });

  it("the guard rejects a role that would bypass RLS (the schema owner)", async () => {
    await expect(assertRlsEffective(ownerPool())).rejects.toThrow(/bypasses Row-Level Security/);
  });
});

describe("Row-Level Security: tenant isolation", () => {
  it("a tenant context only sees its own rows, even with no WHERE clause", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    await seedLead(a.tenantId, { name: "A-lead" });
    await seedLead(b.tenantId, { name: "B-lead" });

    const seenByA = await withTenant(appPool(), a.tenantId, (tx) => tx.query("SELECT name FROM leads"));
    expect(seenByA.rows.map((r) => r.name)).toEqual(["A-lead"]);
    const seenByB = await withTenant(appPool(), b.tenantId, (tx) => tx.query("SELECT name FROM leads"));
    expect(seenByB.rows.map((r) => r.name)).toEqual(["B-lead"]);
  });

  it("with no tenant context the app role sees nothing", async () => {
    const t = await seedTenant("none");
    await seedLead(t.tenantId);
    const { rows } = await appPool().query("SELECT count(*)::int AS n FROM leads");
    expect(rows[0].n).toBe(0);
    const users = await appPool().query("SELECT count(*)::int AS n FROM users");
    expect(users.rows[0].n).toBe(0);
  });

  it("tenant A cannot read tenant B's row by guessing its id", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    const bLead = await seedLead(b.tenantId);
    const { rows } = await withTenant(appPool(), a.tenantId, (tx) => tx.query("SELECT id FROM leads WHERE id = $1", [bLead]));
    expect(rows).toHaveLength(0);
  });

  it("tenant A cannot update or delete tenant B's row (0 rows affected)", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    const bLead = await seedLead(b.tenantId, { name: "untouched" });
    const upd = await withTenant(appPool(), a.tenantId, (tx) => tx.query("UPDATE leads SET name = 'hacked' WHERE id = $1", [bLead]));
    expect(upd.rowCount).toBe(0);
    const del = await withTenant(appPool(), a.tenantId, (tx) => tx.query("DELETE FROM leads WHERE id = $1", [bLead]));
    expect(del.rowCount).toBe(0);
    const { rows } = await ownerPool().query("SELECT name FROM leads WHERE id = $1", [bLead]);
    expect(rows[0].name).toBe("untouched");
  });

  it("tenant A cannot insert a row for tenant B (WITH CHECK)", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    await expectPgError(
      withTenant(appPool(), a.tenantId, (tx) => tx.query("INSERT INTO leads (tenant_id, name) VALUES ($1, 'sneaky')", [b.tenantId])),
      INSUFFICIENT_PRIVILEGE,
      "row-level security",
    );
  });

  it("tenant A cannot move its own row to tenant B by updating tenant_id", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    const leadId = await seedLead(a.tenantId);
    await expectPgError(
      withTenant(appPool(), a.tenantId, (tx) => tx.query("UPDATE leads SET tenant_id = $1 WHERE id = $2", [b.tenantId, leadId])),
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it("the tenant setting is transaction-local and does not leak to the next use of a pooled connection", async () => {
    const a = await seedTenant("a");
    await seedLead(a.tenantId);
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      await withTenant(pool as never, a.tenantId, (tx) => tx.query("SELECT 1"));
      const { rows } = await pool.query("SELECT current_setting('app.tenant_id', true) AS t, (SELECT count(*)::int FROM leads) AS n");
      expect(rows[0].t === null || rows[0].t === "").toBe(true);
      expect(rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("every tenant-scoped table has RLS enabled with a policy", async () => {
    const { rows } = await ownerPool().query<{ relname: string; rls: boolean; policies: number }>(
      `SELECT c.relname, c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
        ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const r of rows) {
      expect(r.rls, `RLS must be enabled on ${r.relname}`).toBe(true);
      expect(r.policies, `${r.relname} needs a policy`).toBeGreaterThan(0);
    }
  });
});

describe("composite foreign keys: no cross-tenant references, even for the schema owner (RLS bypassed)", () => {
  it("a lead cannot be owned by another tenant's user", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    await expectPgError(seedLead(a.tenantId, { owner_id: b.ownerUserId }), FK_VIOLATION);
  });

  it("a client cannot reference another tenant's lead", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    const bLead = await seedLead(b.tenantId);
    await expectPgError(seedClient(a.tenantId, bLead), FK_VIOLATION);
  });

  it("an invoice cannot reference another tenant's client", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    const bClient = await seedClient(b.tenantId, await seedLead(b.tenantId));
    await expectPgError(
      ownerPool().query(
        `INSERT INTO invoices (tenant_id, client_id, idempotency_key, subtotal_minor, total_minor)
         VALUES ($1, $2, 'k1', 100, 100)`,
        [a.tenantId, bClient],
      ),
      FK_VIOLATION,
    );
  });

  it("an activity cannot attach to another tenant's lead", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    const bLead = await seedLead(b.tenantId);
    await expectPgError(
      ownerPool().query("INSERT INTO activities (tenant_id, lead_id, type) VALUES ($1, $2, 'NOTE')", [a.tenantId, bLead]),
      FK_VIOLATION,
    );
  });

  it("a lead cannot point at another tenant's scrape job", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    const { rows } = await ownerPool().query("INSERT INTO scrape_jobs (tenant_id, adapter) VALUES ($1, 'x') RETURNING id", [b.tenantId]);
    await expectPgError(seedLead(a.tenantId, { scrape_job_id: rows[0].id }), FK_VIOLATION);
  });
});

describe("uniqueness enforced by the database", () => {
  it("dedupe_key is unique per tenant, but the same key is fine in another tenant", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    await seedLead(a.tenantId, { dedupe_key: "domain:acme.com" });
    await expectPgError(seedLead(a.tenantId, { dedupe_key: "domain:acme.com" }), UNIQUE_VIOLATION);
    await expect(seedLead(b.tenantId, { dedupe_key: "domain:acme.com" })).resolves.toBeTruthy();
  });

  it("leads without a dedupe_key never collide (they are flagged for review)", async () => {
    const a = await seedTenant("a");
    await seedLead(a.tenantId, { needs_review: true });
    await expect(seedLead(a.tenantId, { needs_review: true })).resolves.toBeTruthy();
  });

  it("a soft-deleted lead frees its dedupe_key", async () => {
    const a = await seedTenant("a");
    const id = await seedLead(a.tenantId, { dedupe_key: "domain:gone.com" });
    await ownerPool().query("UPDATE leads SET deleted_at = now() WHERE id = $1", [id]);
    await expect(seedLead(a.tenantId, { dedupe_key: "domain:gone.com" })).resolves.toBeTruthy();
  });

  it("at most one client per lead (a retried conversion is harmless)", async () => {
    const a = await seedTenant("a");
    const lead = await seedLead(a.tenantId);
    await seedClient(a.tenantId, lead);
    await expectPgError(seedClient(a.tenantId, lead), UNIQUE_VIOLATION);
  });

  it("one invoice per idempotency key and one e-mail per idempotency key", async () => {
    const a = await seedTenant("a");
    const client = await seedClient(a.tenantId, await seedLead(a.tenantId));
    const insertInvoice = () =>
      ownerPool().query(
        `INSERT INTO invoices (tenant_id, client_id, idempotency_key, subtotal_minor, total_minor)
         VALUES ($1, $2, 'conversion:1', 100, 100) RETURNING id`,
        [a.tenantId, client],
      );
    const inv = await insertInvoice();
    await expectPgError(insertInvoice(), UNIQUE_VIOLATION);

    const insertEmail = () =>
      ownerPool().query(
        `INSERT INTO email_outbox (tenant_id, idempotency_key, kind, invoice_id, to_email, subject, body_text)
         VALUES ($1, 'invoice-email:1', 'INVOICE', $2, 'x@example.com', 's', 'b')`,
        [a.tenantId, inv.rows[0].id],
      );
    await insertEmail();
    await expectPgError(insertEmail(), UNIQUE_VIOLATION);
  });

  it("one account per e-mail address across tenants", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    await expectPgError(
      ownerPool().query("INSERT INTO users (tenant_id, email, name, password_hash, role) SELECT $1, email, 'dup', 'x', 'MEMBER' FROM users WHERE tenant_id = $2 LIMIT 1", [b.tenantId, a.tenantId]),
      UNIQUE_VIOLATION,
    );
  });
});

describe("business rules enforced by constraints and triggers", () => {
  it("a CLOSED_WON lead must have a client", async () => {
    const a = await seedTenant("a");
    await expectPgError(seedLead(a.tenantId, { status: "CLOSED_WON" }), CHECK_VIOLATION);
  });

  it("a CLOSED_WON lead is final: its status can never change again", async () => {
    const a = await seedTenant("a");
    const lead = await seedLead(a.tenantId, { status: "NEGOTIATION" });
    const client = await seedClient(a.tenantId, lead);
    await ownerPool().query("UPDATE leads SET status = 'CLOSED_WON', client_id = $2 WHERE id = $1", [lead, client]);
    await expectPgError(ownerPool().query("UPDATE leads SET status = 'NEGOTIATION' WHERE id = $1", [lead]), CHECK_VIOLATION, "cannot change status");
  });

  it("invoice total must equal subtotal + tax, and money cannot be negative", async () => {
    const a = await seedTenant("a");
    const client = await seedClient(a.tenantId, await seedLead(a.tenantId));
    const insert = (sub: number, tax: number, total: number, key: string) =>
      ownerPool().query(
        "INSERT INTO invoices (tenant_id, client_id, idempotency_key, subtotal_minor, tax_minor, total_minor) VALUES ($1,$2,$3,$4,$5,$6)",
        [a.tenantId, client, key, sub, tax, total],
      );
    await expectPgError(insert(1000, 180, 1000, "k-total"), CHECK_VIOLATION);
    await expectPgError(insert(-1, 0, -1, "k-neg"), CHECK_VIOLATION);
    await expect(insert(1000, 180, 1180, "k-ok")).resolves.toBeTruthy();
  });

  it("an issued invoice must have a number; a draft may not", async () => {
    const a = await seedTenant("a");
    const client = await seedClient(a.tenantId, await seedLead(a.tenantId));
    const insert = (status: string, number: string | null, key: string) =>
      ownerPool().query(
        "INSERT INTO invoices (tenant_id, client_id, idempotency_key, status, number, subtotal_minor, total_minor) VALUES ($1,$2,$3,$4,$5,1,1)",
        [a.tenantId, client, key, status, number],
      );
    await expectPgError(insert("ISSUED", null, "k1"), CHECK_VIOLATION);
    await expect(insert("DRAFT", null, "k2")).resolves.toBeTruthy();
    await expect(insert("ISSUED", "INV-000001", "k3")).resolves.toBeTruthy();
    await expectPgError(insert("ISSUED", "INV-000001", "k4"), UNIQUE_VIOLATION);
  });

  it("tax rate must stay within 0-100% (basis points)", async () => {
    const a = await seedTenant("a");
    const client = await seedClient(a.tenantId, await seedLead(a.tenantId));
    const inv = await ownerPool().query(
      "INSERT INTO invoices (tenant_id, client_id, idempotency_key, subtotal_minor, total_minor) VALUES ($1,$2,'k',1,1) RETURNING id",
      [a.tenantId, client],
    );
    await expectPgError(
      ownerPool().query(
        "INSERT INTO invoice_items (tenant_id, invoice_id, position, description, quantity, unit_amount_minor, tax_rate_bp) VALUES ($1,$2,0,'x',1,1,10001)",
        [a.tenantId, inv.rows[0].id],
      ),
      CHECK_VIOLATION,
    );
  });

  it("rejects malformed input at the database edge (bad status, upper-case e-mail, bad slug)", async () => {
    const a = await seedTenant("a");
    await expectPgError(seedLead(a.tenantId, { status: "WON" }), CHECK_VIOLATION);
    await expectPgError(seedLead(a.tenantId, { email: "Upper@Case.com" }), CHECK_VIOLATION);
    await expectPgError(ownerPool().query("INSERT INTO tenants (slug, name) VALUES ('Bad Slug!', 'x')"), CHECK_VIOLATION);
  });
});

describe("append-only tables", () => {
  it("activities cannot be updated or deleted, by the app role or even the owner", async () => {
    const a = await seedTenant("a");
    const lead = await seedLead(a.tenantId);
    const { rows } = await ownerPool().query("INSERT INTO activities (tenant_id, lead_id, type) VALUES ($1,$2,'NOTE') RETURNING id", [a.tenantId, lead]);
    const id = rows[0].id;
    await expectPgError(withTenant(appPool(), a.tenantId, (tx) => tx.query("UPDATE activities SET reason = 'x' WHERE id = $1", [id])), INSUFFICIENT_PRIVILEGE);
    await expectPgError(withTenant(appPool(), a.tenantId, (tx) => tx.query("DELETE FROM activities WHERE id = $1", [id])), INSUFFICIENT_PRIVILEGE);
    await expectPgError(ownerPool().query("UPDATE activities SET reason = 'x' WHERE id = $1", [id]), INSUFFICIENT_PRIVILEGE, "append-only");
    await expectPgError(ownerPool().query("DELETE FROM activities WHERE id = $1", [id]), INSUFFICIENT_PRIVILEGE, "append-only");
  });

  it("audit_log cannot be changed, but the app can append to it", async () => {
    const a = await seedTenant("a");
    const inserted = await withTenant(appPool(), a.tenantId, (tx) =>
      tx.query("INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'test.action') RETURNING id", [a.tenantId]),
    );
    const id = inserted.rows[0].id;
    await expectPgError(withTenant(appPool(), a.tenantId, (tx) => tx.query("UPDATE audit_log SET action = 'x' WHERE id = $1", [id])), INSUFFICIENT_PRIVILEGE);
    await expectPgError(ownerPool().query("DELETE FROM audit_log WHERE id = $1", [id]), INSUFFICIENT_PRIVILEGE, "append-only");
  });
});

describe("concurrency and real-time primitives", () => {
  it("gapless invoice numbering: 12 concurrent issues get 12 distinct consecutive numbers", async () => {
    const a = await seedTenant("a");
    await ownerPool().query("INSERT INTO invoice_counters (tenant_id) VALUES ($1)", [a.tenantId]);
    const issue = () =>
      withTenant(appPool(), a.tenantId, async (tx) => {
        const { rows } = await tx.query(
          "UPDATE invoice_counters SET last_number = last_number + 1 WHERE tenant_id = $1 RETURNING last_number",
          [a.tenantId],
        );
        return rows[0].last_number as number;
      });
    const numbers = await Promise.all(Array.from({ length: 12 }, issue));
    expect([...numbers].sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("a rolled-back issue does not burn an invoice number", async () => {
    const a = await seedTenant("a");
    await ownerPool().query("INSERT INTO invoice_counters (tenant_id) VALUES ($1)", [a.tenantId]);
    await expect(
      withTenant(appPool(), a.tenantId, async (tx) => {
        await tx.query("UPDATE invoice_counters SET last_number = last_number + 1 WHERE tenant_id = $1", [a.tenantId]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const { rows } = await ownerPool().query("SELECT last_number FROM invoice_counters WHERE tenant_id = $1", [a.tenantId]);
    expect(rows[0].last_number).toBe(0);
  });

  it("optimistic concurrency: of 10 simultaneous updates holding the same version, exactly one wins", async () => {
    const a = await seedTenant("a");
    const lead = await seedLead(a.tenantId);
    const attempt = () =>
      withTenant(appPool(), a.tenantId, (tx) =>
        tx.query("UPDATE leads SET status = 'CONTACTED', version = version + 1 WHERE id = $1 AND version = 0", [lead]),
      );
    const results = await Promise.all(Array.from({ length: 10 }, attempt));
    expect(results.filter((r) => r.rowCount === 1)).toHaveLength(1);
    const { rows } = await ownerPool().query("SELECT version FROM leads WHERE id = $1", [lead]);
    expect(rows[0].version).toBe(1);
  });

  it("FOR UPDATE SKIP LOCKED hands each pending e-mail to exactly one of several workers", async () => {
    const a = await seedTenant("a");
    const client = await seedClient(a.tenantId, await seedLead(a.tenantId));
    const inv = await ownerPool().query(
      "INSERT INTO invoices (tenant_id, client_id, idempotency_key, subtotal_minor, total_minor) VALUES ($1,$2,'k',1,1) RETURNING id",
      [a.tenantId, client],
    );
    for (let i = 0; i < 6; i++) {
      await ownerPool().query(
        `INSERT INTO email_outbox (tenant_id, idempotency_key, kind, invoice_id, to_email, subject, body_text)
         VALUES ($1, $2, 'INVOICE', $3, 'x@example.com', 's', 'b')`,
        [a.tenantId, `e-${i}`, inv.rows[0].id],
      );
    }
    const claim = async () => {
      const c = await ownerPool().connect();
      try {
        await c.query("BEGIN");
        const { rows } = await c.query(
          "SELECT id FROM email_outbox WHERE tenant_id = $1 AND status = 'PENDING' ORDER BY created_at LIMIT 2 FOR UPDATE SKIP LOCKED",
          [a.tenantId],
        );
        await new Promise((r) => setTimeout(r, 150)); // hold the locks so the other workers overlap
        await c.query("UPDATE email_outbox SET status = 'SENDING' WHERE id = ANY($1)", [rows.map((r) => r.id)]);
        await c.query("COMMIT");
        return rows.map((r) => r.id as string);
      } finally {
        c.release();
      }
    };
    const claimed = (await Promise.all([claim(), claim(), claim(), claim()])).flat();
    expect(claimed).toHaveLength(6);
    expect(new Set(claimed).size).toBe(6);
  });

  it("row changes emit NOTIFY on commit only, carrying ids but no row data", async () => {
    const a = await seedTenant("a");
    const listener = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await listener.connect();
    const received: Array<{ t: string; e: string; id: string; op: string }> = [];
    listener.on("notification", (m) => received.push(JSON.parse(m.payload ?? "{}")));
    await listener.query("LISTEN apex_changes");
    try {
      // A rolled-back change must not notify.
      await expect(
        withTenant(appPool(), a.tenantId, async (tx) => {
          await tx.query("INSERT INTO leads (tenant_id, name) VALUES ($1, 'ghost')", [a.tenantId]);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      const leadId = await seedLead(a.tenantId, { name: "Real Co", email: "secret@real.example" });
      await ownerPool().query("UPDATE leads SET status = 'CONTACTED' WHERE id = $1", [leadId]);
      await new Promise((r) => setTimeout(r, 300));

      const mine = received.filter((n) => n.t === a.tenantId);
      expect(mine.map((n) => `${n.e}:${n.op}`)).toEqual(["lead:INSERT", "lead:UPDATE"]);
      expect(mine.every((n) => n.id === leadId)).toBe(true);
      expect(JSON.stringify(mine)).not.toContain("secret@real.example");
    } finally {
      await listener.end();
    }
  });

  it("live search: trigram-indexed ILIKE finds leads by name, company, e-mail or website", async () => {
    const a = await seedTenant("a");
    await seedLead(a.tenantId, { name: "Priya Sharma", company_name: "Blossom Studios", website: "https://blossom.example" });
    await seedLead(a.tenantId, { name: "Other Person", company_name: "Zeta Corp" });
    const find = async (q: string) =>
      (await withTenant(appPool(), a.tenantId, (tx) => tx.query("SELECT name FROM leads WHERE search_text ILIKE $1", [`%${q.toLowerCase()}%`]))).rows.map((r) => r.name);
    expect(await find("blossom")).toEqual(["Priya Sharma"]);
    expect(await find("zeta")).toEqual(["Other Person"]);
    expect(await find("nomatch")).toEqual([]);
  });
});
