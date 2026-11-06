import mongoose, { Schema, model } from "mongoose";

/**
 * business_profiles: one per user (unique ownerId). Holds the business details printed on invoices and
 * `defaultTemplateId`, the pointer to the user's default template. Because there is exactly one profile per
 * user, "only one default template per user" is guaranteed by the unique index itself.
 */
const BusinessProfileSchema = new Schema({
  ownerId: { type: String, required: true, unique: true },
  name: { type: String, default: "", maxlength: 120 },
  address: { type: String, default: "", maxlength: 500 },
  gstin: { type: String, default: "", maxlength: 15 },
  state: { type: String, default: "", maxlength: 60 },
  email: { type: String, default: "", maxlength: 200 },
  phone: { type: String, default: "", maxlength: 30 },
  logoAssetId: { type: String, default: "" },
  bankName: { type: String, default: "", maxlength: 80 },
  account: { type: String, default: "", maxlength: 34 },
  ifsc: { type: String, default: "", maxlength: 11 },
  upiId: { type: String, default: "", maxlength: 60 },
  paymentLink: { type: String, default: "", maxlength: 300 },
  qrAssetId: { type: String, default: "" },
  defaultGstRate: { type: Number, default: 0 },
  terms: { type: String, default: "", maxlength: 1000 },
  defaultTemplateId: { type: String, default: "builtin:technolites" },
  /** True once the user clicked "Set default". Profiles that never did use the Technolites template. */
  defaultChosen: { type: Boolean, default: false },
}, { timestamps: true });

/** invoice_templates: a user's own templates. Built-in templates live in code and are never stored. */
const InvoiceTemplateSchema = new Schema({
  ownerId: { type: String, required: true },
  name: { type: String, required: true, maxlength: 80 },
  type: { type: String, enum: ["html", "docx", "builder"], required: true },
  currentVersionId: { type: String, required: true },
  currentVersion: { type: Number, required: true },
}, { timestamps: true });
InvoiceTemplateSchema.index({ ownerId: 1, updatedAt: -1 });

/**
 * invoice_template_versions: append-only. Editing a template adds a version; nothing here is ever updated,
 * so an invoice that recorded a version id always renders exactly as it was sent.
 */
const InvoiceTemplateVersionSchema = new Schema({
  templateId: { type: String, required: true },
  ownerId: { type: String, required: true },
  version: { type: Number, required: true },
  source: { type: String, required: true, maxlength: 1_000_000 },
  builder: { type: Schema.Types.Mixed },
  originalAssetId: { type: String },
  createdBy: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
InvoiceTemplateVersionSchema.index({ templateId: 1, version: 1 }, { unique: true });

/** template_assets: logos, signatures, fonts, original DOCX files. The file lives on disk; the row records owner and type. */
const TemplateAssetSchema = new Schema({
  ownerId: { type: String, required: true },
  name: { type: String, required: true, maxlength: 80 },
  mime: { type: String, required: true },
  size: { type: Number, required: true },
  sha256: { type: String, required: true },
  path: { type: String, required: true },
}, { timestamps: true });
TemplateAssetSchema.index({ ownerId: 1, name: 1 }, { unique: true });

export const BusinessProfile = mongoose.models.BusinessProfile ?? model("BusinessProfile", BusinessProfileSchema);
export const InvoiceTemplate = mongoose.models.InvoiceTemplate ?? model("InvoiceTemplate", InvoiceTemplateSchema);
export const InvoiceTemplateVersion = mongoose.models.InvoiceTemplateVersion ?? model("InvoiceTemplateVersion", InvoiceTemplateVersionSchema);
export const TemplateAsset = mongoose.models.TemplateAsset ?? model("TemplateAsset", TemplateAssetSchema);

export interface BusinessInfo {
  name: string; address: string; gstin: string; state: string; email: string; phone: string; logoAssetId: string;
  bankName: string; account: string; ifsc: string; upiId: string; paymentLink: string; qrAssetId: string;
  defaultGstRate: number; terms: string; defaultTemplateId: string;
}
export const EMPTY_BUSINESS: BusinessInfo = {
  name: "", address: "", gstin: "", state: "", email: "", phone: "", logoAssetId: "", bankName: "", account: "", ifsc: "", upiId: "",
  paymentLink: "", qrAssetId: "", defaultGstRate: 0, terms: "", defaultTemplateId: "builtin:technolites",
};
