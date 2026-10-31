import mongoose, { Schema, model, models } from "mongoose";

const LeadSchema = new Schema(
  {
    website: {
      type: String,
      required: true,
      trim: true
    },

    title: {
      type: String,
      required: true,
      trim: true
    },

    email: {
      type: String,
      lowercase: true,
      trim: true,
      default: null
    },

    source: {
      type: String,
      required: true
    },

    scrapedAt: {
      type: Date,
      required: true
    },

    dedupeKey: {
      type: String,
      required: true,
      unique: true
    }
  },
  {
    timestamps: true
  }
);

export const Lead =
  models.Lead || model("Lead", LeadSchema);