import { connectDB } from "./config/database";
import mongoose from "mongoose";

async function main() {
  await connectDB();
  await mongoose.disconnect();
  console.log("Database test completed!");
}

main().catch(async (error) => {
  console.error("Database test failed:", error.message);
  await mongoose.disconnect();
  process.exitCode = 1;
});