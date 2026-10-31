import { Schema, model, type InferSchemaType } from "mongoose";

const tenantSchema = new Schema(
  {
    slug: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: ["ACTIVE", "SUSPENDED"], default: "ACTIVE" },
  },
  { timestamps: true },
);

tenantSchema.index({ slug: 1 }, { unique: true });

export type TenantDoc = InferSchemaType<typeof tenantSchema>;
export const Tenant = model("Tenant", tenantSchema);
