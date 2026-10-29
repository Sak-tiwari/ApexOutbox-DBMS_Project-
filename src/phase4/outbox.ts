
import mongoose, { Schema } from "mongoose";

const OutboxSchema = new Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    eventType: {
      type: String,
      required: true
    },
    aggregateId: {
      type: String,
      required: true
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true
    },
    status: {
      type: String,
      enum: ["PENDING", "PROCESSING", "PUBLISHED"],
      default: "PENDING",
      index: true
    },
    attempts: {
      type: Number,
      default: 0
    },
    lastError: {
      type: String,
      default: ""
    },
    publishedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

export const OutboxEvent =
  mongoose.models.OutboxEvent ||
  mongoose.model("OutboxEvent", OutboxSchema);

export async function recordOnboardingEvent(
  invoiceId: string
) {
  const eventId = `invoice-created:${invoiceId}`;

  return OutboxEvent.findOneAndUpdate(
    { eventId },
    {
      $setOnInsert: {
        eventId,
        eventType: "INVOICE_CREATED",
        aggregateId: invoiceId,
        payload: { invoiceId },
        status: "PENDING"
      }
    },
    {
      upsert: true,
      new: true
    }
  );
}
