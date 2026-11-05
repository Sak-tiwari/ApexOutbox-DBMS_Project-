import { randomUUID } from "node:crypto";
import { CheerioCrawler, Configuration, RequestQueue, log as crawleeLog } from "@crawlee/cheerio";
import { extractFromHtml } from "./extract";
import { checkUrl, type SafeUrlOptions } from "./safeUrl";

export const SCRAPER_USER_AGENT = "ApexOutboxBot/1.0 (+lead research; respects robots.txt)";
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 3_000_000;

// Crawlee logs every crawl at INFO; only problems are interesting in our own logs.
crawleeLog.setLevel(crawleeLog.LEVELS.OFF);

export type ScrapeOutcome =
  | { ok: true; finalUrl: string; title: string; emails: string[]; phones: string[]; pagesRead: number }
  | { ok: false; reason: "UNSAFE_URL" | "ROBOTS" | "HTTP_ERROR" | "NOT_HTML" | "TOO_MANY_REDIRECTS" | "FAILED"; message: string };

interface HopResult {
  status?: number;
  location?: string;
  html?: string;
  contentType?: string;
  skipped?: boolean;
  error?: string;
}

/** One request through Crawlee. Redirects are NOT followed here: the caller validates each hop. */
async function fetchOnce(url: string): Promise<HopResult> {
  const result: HopResult = {};
  // Own in-memory queue and storage per hop: nothing is written to disk and runs cannot see each other.
  const config = new Configuration({ persistStorage: false });
  const queue = await RequestQueue.open(randomUUID(), { config });
  const crawler = new CheerioCrawler(
    {
      requestQueue: queue,
      maxRequestsPerCrawl: 1,
      maxRequestRetries: 1,
      requestHandlerTimeoutSecs: 30,
      navigationTimeoutSecs: 20,
      respectRobotsTxtFile: { userAgent: SCRAPER_USER_AGENT },
      useSessionPool: false,
      // Body-less redirect responses arrive as application/octet-stream; without this Crawlee throws
      // before we can read the Location header. Real downloads are rejected by NOT_HTML / the size cap below.
      additionalMimeTypes: ["application/octet-stream"],
      ignoreHttpErrorStatusCodes: [301, 302, 303, 307, 308, 400, 401, 403, 404, 405, 410, 429],
      preNavigationHooks: [
        (_ctx, gotOptions) => {
          gotOptions.followRedirect = false;
          gotOptions.headers = { ...gotOptions.headers, "user-agent": SCRAPER_USER_AGENT };
          // Crawlee refuses to hand us redirect responses that have no body, so read status and
          // Location straight from the HTTP response, before Crawlee looks at it.
          gotOptions.hooks = {
            ...gotOptions.hooks,
            afterResponse: [
              ...(gotOptions.hooks?.afterResponse ?? []),
              (response) => {
                if (Number(response.headers["content-length"] ?? 0) > MAX_BODY_BYTES) throw new Error("The page is too large to scrape");
                result.status = response.statusCode;
                result.contentType = String(response.headers["content-type"] ?? "");
                if (response.headers.location) result.location = String(response.headers.location);
                return response;
              },
            ],
          };
        },
      ],
      async requestHandler({ response, body }) {
        result.status = response.statusCode;
        result.contentType = String(response.headers["content-type"] ?? "");
        const loc = response.headers.location;
        if (loc) result.location = String(loc);
        result.html = typeof body === "string" ? body : body.toString("utf8");
      },
      onSkippedRequest: () => {
        result.skipped = true;
      },
      async failedRequestHandler(_ctx, error) {
        result.error = error instanceof Error ? error.message : String(error);
      },
    },
    config,
  );
  try {
    await crawler.run([{ url, uniqueKey: randomUUID() }]);
  } finally {
    await queue.drop().catch(() => undefined);
  }
  return result;
}

/**
 * Fetches one page politely (robots.txt respected, identified user agent) and extracts the contact
 * emails and title. SSRF checks run for the first URL and again for every redirect target.
 */
async function scrapeOne(inputUrl: string, safe: SafeUrlOptions, fetchHop: (url: string) => Promise<HopResult>): Promise<ScrapeOutcome & { contactLinks?: string[] }> {
  let current = inputUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await checkUrl(current, safe);
    if (!check.ok) return { ok: false, reason: "UNSAFE_URL", message: check.reason };

    const r = await fetchHop(check.url.toString());
    if (r.skipped) return { ok: false, reason: "ROBOTS", message: "This website's robots.txt does not allow automated visits, so it was not scraped" };
    const isRedirect = r.status !== undefined && r.status >= 300 && r.status < 400 && !!r.location;
    if (r.error && /served Content-Type/.test(r.error)) return { ok: false, reason: "NOT_HTML", message: "That address is not a web page (HTML)" };
    if (r.error && /too large/.test(r.error)) return { ok: false, reason: "FAILED", message: "The page is too large to scrape" };
    if (r.error && !isRedirect && (r.status === undefined || r.status < 400)) return { ok: false, reason: "FAILED", message: `Could not load the page: ${r.error.slice(0, 200)}` };

    if (isRedirect) {
      try {
        current = new URL(r.location as string, check.url).toString();
      } catch {
        return { ok: false, reason: "FAILED", message: "The website sent an invalid redirect" };
      }
      continue;
    }
    if (r.status && r.status >= 400) return { ok: false, reason: "HTTP_ERROR", message: `The website answered with HTTP ${r.status}` };
    if (!/html|xml/i.test(r.contentType ?? "")) return { ok: false, reason: "NOT_HTML", message: "That address is not a web page (HTML)" };

    const { title, emails, phones, contactLinks } = extractFromHtml(r.html ?? "", check.url.toString());
    return { ok: true, finalUrl: check.url.toString(), title, emails, phones, pagesRead: 1, contactLinks };
  }
  return { ok: false, reason: "TOO_MANY_REDIRECTS", message: "The website redirected too many times" };
}

/**
 * Reads the page you give it, then up to two "Contact" / "About" pages linked from it on the same
 * website (the address is usually there, not on the home page), and merges what they contain.
 * Only the first page decides success: a broken contact page never fails the job.
 */
export async function scrapePage(inputUrl: string, safe: SafeUrlOptions = {}, fetchHop: (url: string) => Promise<HopResult> = fetchOnce): Promise<ScrapeOutcome> {
  const first = await scrapeOne(inputUrl, safe, fetchHop);
  if (!first.ok) return first;
  const emails = [...first.emails];
  const phones = [...first.phones];
  let pagesRead = 1;
  for (const link of first.contactLinks ?? []) {
    const extra = await scrapeOne(link, safe, fetchHop).catch(() => null);
    if (!extra || !extra.ok) continue;
    pagesRead++;
    for (const e of extra.emails) if (!emails.includes(e) && emails.length < 20) emails.push(e);
    for (const ph of extra.phones) if (!phones.includes(ph) && phones.length < 5) phones.push(ph);
  }
  return { ok: true, finalUrl: first.finalUrl, title: first.title, emails, phones, pagesRead };
}
