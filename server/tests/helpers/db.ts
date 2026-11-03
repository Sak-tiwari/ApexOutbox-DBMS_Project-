import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createPool, type Db } from "../../src/db/pool.js";

dotenv.config({ path: new URL("../../.env.test", import.meta.url).pathname });

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see server/.env.test)`);
  return v;
}

let app: Db | undefined;
let owner: Db | undefined;

/** The limited application role (apex_app): Row-Level Security applies to it. */
export function appPool(): Db {
  return (app ??= createPool(need("TEST_DATABASE_URL"), { max: 8, applicationName: "apex-test-app" }));
}

/** The schema owner: bypasses RLS (no FORCE), used to seed data and to prove constraints independent of RLS. */
export function ownerPool(): Db {
  return (owner ??= createPool(need("TEST_MIGRATION_DATABASE_URL"), { max: 4, applicationName: "apex-test-owner" }));
}

export async function closePools(): Promise<void> {
  await Promise.all([app?.end(), owner?.end()]);
  app = owner = undefined;
}

export interface SeededTenant {
  tenantId: string;
  ownerUserId: string;
  memberUserId: string;
}

/** Creates a tenant with an OWNER and a MEMBER user (through the owner connection, bypassing RLS). */
export async function seedTenant(label = "t"): Promise<SeededTenant> {
  const db = ownerPool();
  const suffix = randomUUID().slice(0, 8);
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id",
    [`${label}-${suffix}`, `Tenant ${label} ${suffix}`],
  );
  const tenantId = rows[0]!.id;
  const mk = async (role: string) =>
    (
      await db.query<{ id: string }>(
        "INSERT INTO users (tenant_id, email, name, password_hash, role) VALUES ($1, $2, $3, 'x', $4) RETURNING id",
        [tenantId, `${role.toLowerCase()}-${suffix}-${label}@example.com`, `${role} ${label}`, role],
      )
    ).rows[0]!.id;
  return { tenantId, ownerUserId: await mk("OWNER"), memberUserId: await mk("MEMBER") };
}

export async function seedLead(tenantId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const row = { name: "Acme Ltd", ...fields };
  const cols = ["tenant_id", ...Object.keys(row)];
  const vals = [tenantId, ...Object.values(row)];
  const { rows } = await ownerPool().query<{ id: string }>(
    `INSERT INTO leads (${cols.join(", ")}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    vals,
  );
  return rows[0]!.id;
}

export async function seedClient(tenantId: string, leadId: string): Promise<string> {
  const { rows } = await ownerPool().query<{ id: string }>(
    "INSERT INTO clients (tenant_id, lead_id, name, email) VALUES ($1, $2, 'Acme', 'billing@acme.example') RETURNING id",
    [tenantId, leadId],
  );
  return rows[0]!.id;
}

/** Asserts that a promise rejects with a Postgres error carrying the given SQLSTATE code. */
export async function expectPgError(promise: Promise<unknown>, code: string, messagePart?: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected a Postgres error ${code}, but the query succeeded`).toBeDefined();
  expect((caught as { code?: string }).code).toBe(code);
  if (messagePart) expect(String((caught as Error).message)).toContain(messagePart);
}
