
import mongoose, { Schema } from "mongoose";

const ClientSchema = new Schema(
  {
    sourceLeadId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    name: {
      type: String,
      required: true
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    company: {
      type: String,
      default: ""
    }
  },
  { timestamps: true }
);

const InvoiceSchema = new Schema(
  {
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    clientId: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true
    },
    invoiceNumber: {
      type: String,
      required: true,
      unique: true
    },
    // Invoice Templates: owner and the number printed on the invoice. A user cannot use the same printed
    // number twice; invoices made before this feature have neither field and are skipped by the sparse index.
    ownerId: { type: String },
    displayNumber: { type: String },
    snapshot: {
      type: Schema.Types.Mixed,
      required: true
    },
    pdfPath: {
      type: String,
      default: ""
    },
    status: {
      type: String,
      enum: [
        "PENDING",
        "PDF_READY",
        "EMAIL_SENDING",
        "EMAIL_SENT",
        "EMAIL_FAILED",
        "EMAIL_UNCERTAIN",
        "EMAIL_ABANDONED"
      ],
      default: "PENDING"
    },
    emailAttempts: {
      type: Number,
      default: 0
    },
    emailMessageId: {
      type: String,
      default: ""
    },
    lastError: {
      type: String,
      default: ""
    }
  },
  { timestamps: true }
);

InvoiceSchema.index({ ownerId: 1, displayNumber: 1 }, { unique: true, sparse: true });

export const Client = mongoose.models.Client || mongoose.model(
  "Client",
  ClientSchema
);

export const Invoice = mongoose.models.Invoice || mongoose.model(
  "Invoice",
  InvoiceSchema
);
