export type PostedWithin = "24h" | "7d" | "30d";

export interface SearchFilters {
  /** Source ids to use. Empty/undefined = every enabled source. */
  platforms?: string[];
  budgetMin?: number;
  budgetMax?: number;
  postedWithin?: PostedWithin;
  /** Substring of the job's location, e.g. "India". */
  location?: string;
  remoteOnly?: boolean;
  level?: "entry" | "mid" | "senior";
}

/** What a source module returns for one post. Everything except id, title and url is optional. */
export interface RawLead {
  externalId: string;
  title: string;
  url: string;
  company?: string;
  description?: string;
  budgetText?: string;
  budgetMin?: number;
  budgetMax?: number;
  location?: string;
  remote?: boolean;
  postedAt?: Date;
}

export interface SourceQuery {
  keywords: string[];
  filters: SearchFilters;
}

export interface SourceContext {
  /** Polite HTTP GET: timeout, retries with backoff, per-host spacing, size cap, short cache. */
  get(url: string, opts?: { headers?: Record<string, string> }): Promise<string>;
}

/**
 * A place that publishes people asking for work. Add a new one by creating a file in
 * src/leadFinder/sources/ and listing it in sources/index.ts (see README).
 */
export interface LeadSource {
  id: string;
  name: string;
  search(query: SourceQuery, ctx: SourceContext): Promise<RawLead[]>;
}

/** Thrown by a source when the site refused us (403/429/login wall). Shown as "blocked", not "failed". */
export class SourceBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceBlockedError";
  }
}
