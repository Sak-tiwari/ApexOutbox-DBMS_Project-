import mongoose from "mongoose";
import { connectDB } from "./config/database";
import { saveLeads } from "./lead-ingestion.service";

async function test() {
  try {
    await connectDB();

    await saveLeads({
      website: "https://test-company.com",
      title: "ABC Test Company",
      emails: ["test@example.com"],
      source: "Local HTML Fixture Test",
      scrapedAt: new Date().toISOString()
    });

    console.log("SUCCESS: Test lead saved in MongoDB!");
  } catch (error) {
    console.error("Test failed:", error);
  } finally {
    await mongoose.disconnect();
  }
}

test();