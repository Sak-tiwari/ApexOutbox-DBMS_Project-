import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

// Arbitrary constant: serialises concurrent `db:migrate` runs (e.g. two containers starting together).
const MIGRATION_LOCK_ID = 727_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Minimal forward-only migration runner.
 * - Files are `NNN_name.sql`, applied in name order, each inside its own transaction.
 * - A checksum is stored; editing an already-applied file is an error (write a new migration instead).
 * - Must be run with the schema OWNER connection (apex_owner), never the app role.
 */
export async function runMigrations(
  connectionString: string,
  dir: string = DEFAULT_MIGRATIONS_DIR,
  log: (msg: string) => void = () => {},
): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString, application_name: "apexoutbox-migrate" });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const { rows } = await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations");
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
        }
        result.skipped.push(file);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
      }
      log(`applied ${file}`);
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    await client.end();
  }
}
