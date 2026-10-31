import { CheerioCrawler } from "crawlee";
import { writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { connectDB } from "../config/database";
import { saveLeads } from "../lead-ingestion.service";
import { isSafeUrl } from "../utils/safe-url";

type LeadData = {
  website: string;
  title: string;
  emails: string[];
  source: string;
  scrapedAt: string;
};

async function scrapeLeads() {
  let databaseConnected = false;

  try {
    const inputUrl = process.argv[2] || "https://example.com";

    // Validate URL before scraping
    const safe = await isSafeUrl(inputUrl);

    if (!safe) {
      throw new Error("Unsafe or invalid URL. Scraping stopped.");
    }

    const url = new URL(inputUrl).toString();

    console.log("Starting Crawlee Lead Scraper...");
    console.log("Website:", url);

    let leadData: LeadData | null = null;

    const crawler = new CheerioCrawler({
      maxRequestsPerCrawl: 1,
      maxRequestRetries: 2,
      requestHandlerTimeoutSecs: 30,

      async requestHandler({ request, $ }) {
        const html = $.html() || "";

        const title =
          $("title").first().text().trim() || "Unknown Website";

        const emails = [
          ...new Set(
            html.match(
              /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
            ) || []
          )
        ];

        leadData = {
          website: request.url,
          title,
          emails,
          source: "Crawlee CheerioCrawler",
          scrapedAt: new Date().toISOString()
        };

        console.log("Page extracted successfully.");
        console.log("Emails found:", emails.length);
      },

      failedRequestHandler({ request }, error) {
        console.error("Request failed:", request.url);
        console.error("Error:", error.message);
      }
    });

    await crawler.run([url]);

    const extractedData = leadData as LeadData | null;

    if (!extractedData) {
      throw new Error("No lead data was extracted.");
    }

    await writeFile(
      "leads.json",
      JSON.stringify(extractedData, null, 2),
      "utf-8"
    );

    console.log("Data saved in leads.json");

    if (extractedData.emails.length > 0) {
      await connectDB();
      databaseConnected = true;

      await saveLeads(extractedData);

      console.log("Leads saved successfully in MongoDB!");
    } else {
      console.log("No emails found. Nothing to save in MongoDB.");
    }

    console.log("Scraping completed!");
    console.log(extractedData);

  } catch (error) {
    console.error(
      "Scraping failed:",
      error instanceof Error ? error.message : error
    );

    process.exitCode = 1;

  } finally {
    if (databaseConnected) {
      await mongoose.disconnect();
      console.log("MongoDB disconnected.");
    }
  }
}

scrapeLeads();