import { load } from "cheerio";
import { SourceAdapter } from "./source-adapter";

export const genericHtmlAdapter: SourceAdapter = {
  name: "Generic HTML Adapter",

  canHandle(url: URL): boolean {
    return ["http:", "https:"].includes(url.protocol);
  },

  extract(html: string, url: string) {
    const $ = load(html);

    const title = $("title").first().text().trim();

    const emails = [
      ...new Set(
        html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
      )
    ];

    return {
      website: url,
      title: title || "Unknown Website",
      emails,
      source: "Generic HTML Adapter",
      scrapedAt: new Date().toISOString()
    };
  }
};