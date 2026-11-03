import type { Tx } from "./db/pool.js";

export interface AuditEntry {
  tenantId: string;
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  /** Small, non-sensitive facts only. NEVER secrets, passwords, tokens or e-mail bodies. */
  metadata?: Record<string, unknown>;
  ip?: string;
}

/** Append-only. Call inside the same transaction as the change it records, so both commit or neither does. */
export async function writeAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.tenantId,
      entry.actorId ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.ip ?? null,
    ],
  );
}
