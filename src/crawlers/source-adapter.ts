export type ExtractedLead = {
  website: string;
  title: string;
  emails: string[];
  source: string;
  scrapedAt: string;
};

export interface SourceAdapter {
  name: string;
  canHandle(url: URL): boolean;
  extract(html: string, url: string): ExtractedLead;
}