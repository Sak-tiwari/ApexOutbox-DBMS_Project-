import { SourceAdapter } from "./source-adapter";

export const genericHtmlAdapter: SourceAdapter = {
  name: "Generic HTML Adapter",

  canHandle(url: URL): boolean {
    return ["http:", "https:"].includes(url.protocol);
  },

  extract(html: string, url: string) {
    const titleMatch = html.match(
      /<title\b[^>]>([\s\S]?)<\/title\s*>/i
    );

    const emails = [
      ...new Set(
        html.match(
          /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
        ) || []
      )
    ];

    return {
      website: url,
      title: titleMatch?.[1]?.trim() || "Unknown Website",
      emails,
      source: "Generic HTML Adapter",
      scrapedAt: new Date().toISOString()
    };
  }
};