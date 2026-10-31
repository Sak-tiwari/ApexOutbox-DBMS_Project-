import { Schema, model, type InferSchemaType } from "mongoose";

const lineItemSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    // Money is stored as integer minor units (paise) to avoid floating-point errors.
    unitAmountMinor: { type: Number, required: true, min: 0, validate: Number.isInteger },
    taxRateBp: { type: Number, default: 0, min: 0, max: 10000 }, // basis points: 1800 = 18%
  },
  { _id: false },
);

const invoiceSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: true },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", required: true },

    // Stable key, e.g. "conversion:<leadId>". One intended invoice per billing event.
    idempotencyKey: { type: String, required: true },
    // Human-facing sequential number, allocated per tenant (see counters in Phase 4).
    number: { type: String },

    status: {
      type: String,
      enum: ["DRAFT", "ISSUED", "SENT", "PAID", "VOID"],
      default: "DRAFT",
      required: true,
    },
    currency: { type: String, default: "INR", required: true },
    items: { type: [lineItemSchema], validate: (v: unknown[]) => v.length > 0 },
    totalMinor: { type: Number, required: true, min: 0, validate: Number.isInteger },

    // Immutable snapshot used to render the PDF. Later edits to the client never change an issued invoice.
    snapshot: { type: Schema.Types.Mixed },
    pdf: {
      storageKey: String,
      sha256: String,
      generatedAt: Date,
    },
    issuedAt: Date,
  },
  { timestamps: true },
);

invoiceSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
invoiceSchema.index(
  { tenantId: 1, number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: "string" } } },
);
invoiceSchema.index({ tenantId: 1, clientId: 1, createdAt: -1 });

export type InvoiceDoc = InferSchemaType<typeof invoiceSchema>;
export const Invoice = model("Invoice", invoiceSchema);
