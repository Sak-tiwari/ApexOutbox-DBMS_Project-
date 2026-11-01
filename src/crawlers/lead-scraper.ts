import { CheerioCrawler } from "crawlee";
import { writeFile } from "node:fs/promises";
import mongoose from "mongoose";

import { connectDB } from "../config/database";
import { saveLeads } from "../lead-ingestion.service";
import { isSafeUrl } from "../utils/safe-url";
import { ScrapeJob } from "../models/ScrapeJob";
import { genericHtmlAdapter } from "./generic-html.adapter";

type LeadData = {
  website: string;
  title: string;
  emails: string[];
  source: string;
  scrapedAt: string;
};

async function scrapeLeads() {
  let databaseConnected = false;
  let jobId: mongoose.Types.ObjectId | null = null;

  try {
    const inputUrl = process.argv[2] || "https://example.com";

    if (!(await isSafeUrl(inputUrl))) {
      throw new Error("Unsafe or invalid URL");
    }

    const url = new URL(inputUrl).toString();

    await connectDB();
    databaseConnected = true;

    const job = await ScrapeJob.create({
      targetUrl: url,
      status: "running",
      totalRequests: 1
    });

    jobId = job._id;

    let leadData: LeadData | null = null;

    const crawler = new CheerioCrawler({
      maxRequestsPerCrawl: 1,
      maxRequestRetries: 2,
      requestHandlerTimeoutSecs: 30,

      async requestHandler({ request, $ }) {
        const html = $.html() || "";

        leadData = genericHtmlAdapter.extract(html, request.url);

        console.log("Page extracted successfully.");
        console.log("Emails found:", leadData.emails.length);
      },

      

     async errorHandler(_context, error) {
  if (jobId) {
    await ScrapeJob.updateOne(
      { _id: jobId },
      {
        $inc: { retries: 1 },
        $push: {
          errorMessages:
            error instanceof Error ? error.message : String(error)
        }
      }
    );
  }
},
    });

    await crawler.run([url]);

    const extracted = leadData;

    if (!extracted) {
      throw new Error("No lead data extracted");
    }

    await writeFile(
      "leads.json",
      JSON.stringify(extracted, null, 2),
      "utf-8"
    );

    await saveLeads(extracted);

    await ScrapeJob.updateOne(
      { _id: jobId },
      {
        $set: {
          status: "completed",
          successfulRequests: 1,
          finishedAt: new Date()
        }
      }
    );

    console.log("Lead saved and job completed!");
    console.log(extracted);

  } catch (error) {
    console.error("Scraping failed:", error);

    if (jobId) {
      await ScrapeJob.updateOne(
        { _id: jobId },
        {
          $set: {
            status: "failed",
            finishedAt: new Date()
          },
          $push: {
            errorMessages:
              error instanceof Error ? error.message : String(error)
          }
        }
      );
    }

    process.exitCode = 1;

  } finally {
    if (databaseConnected) {
      await mongoose.disconnect();
      console.log("MongoDB disconnected.");
    }
  }
}

scrapeLeads();