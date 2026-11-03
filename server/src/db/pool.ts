import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

// Return bigint (money in paise) as a JS number only when it is safe; otherwise keep the string.
// int8 values we store (paise, counters) stay far below 2^53; a larger value is a bug worth surfacing.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint value ${v} does not fit in a JS number`);
  return n;
});

export function createPool(connectionString: string, options: { max?: number; applicationName?: string } = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: options.applicationName ?? "apexoutbox",
    // A runaway query must not hold a connection forever.
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  // An error on an idle client (e.g. the server restarted) must not crash the process.
  pool.on("error", () => {});
  return pool;
}

/** Runs `fn` inside one transaction. Commits on success, rolls back on any thrown error. */
export async function withTx<T>(pool: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await tx.query("ROLLBACK");
    } catch {
      // The connection may already be broken; the original error is the one that matters.
    }
    throw error;
  } finally {
    tx.release();
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * THE way application code touches tenant data.
 *
 * Opens a transaction and sets `app.tenant_id` for its duration (set_config(..., true) is
 * transaction-local, so it can never leak to the next request on a pooled connection).
 * Row-Level Security then hides every other tenant's rows from this transaction even if a query
 * forgets its `WHERE tenant_id = $1`. Queries should still filter by tenant_id explicitly.
 */
export async function withTenant<T>(pool: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(tenantId)) throw new Error("withTenant: tenantId must be a UUID");
  return withTx(pool, async (tx) => {
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return fn(tx);
  });
}

/** Cheap connectivity probe for /ready. */
export async function pingDb(pool: Db): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Safety net: Row-Level Security does not apply to superusers, BYPASSRLS roles or table owners.
 * If the app was accidentally pointed at such a role, tenant isolation would silently rely on
 * application code alone. Refuse to start instead.
 */
export async function assertRlsEffective(pool: Db): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; owns_tables: boolean; who: string }>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolname AS who,
            EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relowner = r.oid) AS owns_tables
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const row = rows[0];
  if (!row) throw new Error("Could not determine the database role in use");
  if (row.rolsuper || row.rolbypassrls || row.owns_tables) {
    throw new Error(
      `Database role "${row.who}" bypasses Row-Level Security (superuser, BYPASSRLS or table owner). ` +
        `Connect the app as the limited apex_app role (see scripts/db-setup.sh).`,
    );
  }
}
