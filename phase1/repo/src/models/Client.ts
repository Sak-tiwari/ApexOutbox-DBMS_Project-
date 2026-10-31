import { Schema, model, type InferSchemaType } from "mongoose";

const clientSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    // One lead converts to at most one client. The unique index makes a retry harmless.
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", required: true },
    name: { type: String, required: true, trim: true },
    companyName: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    billingAddress: {
      line1: String,
      line2: String,
      city: String,
      state: String,
      postalCode: String,
      country: { type: String, default: "IN" },
    },
    taxId: { type: String, trim: true }, // e.g. GSTIN; optional
  },
  { timestamps: true },
);

clientSchema.index({ tenantId: 1, leadId: 1 }, { unique: true });
clientSchema.index({ tenantId: 1, createdAt: -1 });

export type ClientDoc = InferSchemaType<typeof clientSchema>;
export const Client = model("Client", clientSchema);
