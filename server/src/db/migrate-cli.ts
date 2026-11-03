import "dotenv/config";
import { runMigrations } from "./migrate.js";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL is required (the schema-owner connection, not the app role).");
  process.exit(1);
}

runMigrations(url, undefined, (m) => console.log(m))
  .then((r) => console.log(`Migrations done: ${r.applied.length} applied, ${r.skipped.length} already up to date.`))
  .catch((error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  });
