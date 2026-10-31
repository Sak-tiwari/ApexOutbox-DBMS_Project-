import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "node:path";

dotenv.config({
  path: path.resolve(process.cwd(), ".env"),
});

export async function connectDB() {
  const mongoUri = process.env.MONGODB_URI?.trim();

  if (!mongoUri) {
    throw new Error("MONGODB_URI missing in root .env file");
  }

  await mongoose.connect(mongoUri);
  console.log("MongoDB connected successfully!");
}