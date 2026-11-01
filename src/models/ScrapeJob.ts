import mongoose, { Schema } from "mongoose";

const scrapeJobSchema = new Schema(
  {
    targetUrl: {
      type: String,
      required: true
    },
    status: {
      type: String,
      enum: ["running", "completed", "failed"],
      default: "running",
      required: true
    },
    totalRequests: {
      type: Number,
      default: 0
    },
    successfulRequests: {
      type: Number,
      default: 0
    },
    failedRequests: {
      type: Number,
      default: 0
    },
    retries: {
      type: Number,
      default: 0
    },
    errorsMessages: {
      type: [String],
      default: []
    },
    startedAt: {
      type: Date,
      default: Date.now
    },
    finishedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

export const ScrapeJob =
  mongoose.models.ScrapeJob ||
  mongoose.model("ScrapeJob", scrapeJobSchema);