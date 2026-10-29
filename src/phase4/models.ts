
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
        "EMAIL_SENT",
        "EMAIL_FAILED"
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

export const Client = mongoose.model(
  "Client",
  ClientSchema
);

export const Invoice = mongoose.model(
  "Invoice",
  InvoiceSchema
);
