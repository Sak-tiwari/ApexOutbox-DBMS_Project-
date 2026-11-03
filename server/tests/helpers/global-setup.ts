import dotenv from "dotenv";
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.js";

/**
 * Runs once before the whole test run: wipes the TEST database and applies every migration with the
 * real migration runner, so tests always exercise the real schema (no mocks, no in-memory fake).
 */
export default async function setup() {
  dotenv.config({ path: new URL("../../.env.test", import.meta.url).pathname });
  const url = process.env.TEST_MIGRATION_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_MIGRATION_DATABASE_URL is not set. Create a test database with scripts/db-setup.sh and put the " +
        "TEST_* URLs in server/.env.test (see .env.example).",
    );
  }
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error("Refusing to wipe a database whose name does not contain 'test'.");
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
  await runMigrations(url);
}
