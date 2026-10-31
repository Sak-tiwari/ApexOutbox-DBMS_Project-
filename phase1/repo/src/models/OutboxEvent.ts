import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Transactional outbox. A row is inserted in the SAME database transaction as the business change
 * (e.g. lead -> CLOSED_WON + client). A separate dispatcher later publishes pending rows to BullMQ.
 * This removes the "database committed but queue publish failed" gap.
 */
export const OUTBOX_EVENT_TYPES = ["LEAD_CONVERTED", "INVOICE_READY_TO_SEND"] as const;

const outboxSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    type: { type: String, enum: OUTBOX_EVENT_TYPES, required: true },
    aggregateType: { type: String, required: true }, // "Lead" | "Invoice"
    aggregateId: { type: Schema.Types.ObjectId, required: true },
    // Dedupes the event itself: same business fact => same key => only one row.
    idempotencyKey: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },

    status: {
      type: String,
      enum: ["PENDING", "PUBLISHED", "FAILED"],
      default: "PENDING",
      required: true,
    },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lastError: String,
    publishedAt: Date,
  },
  { timestamps: true },
);

outboxSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
// Dispatcher polls: PENDING rows that are due, oldest first.
outboxSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

export type OutboxEventDoc = InferSchemaType<typeof outboxSchema>;
export const OutboxEvent = model("OutboxEvent", outboxSchema);
