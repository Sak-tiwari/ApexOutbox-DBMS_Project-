import type { Log } from "../phase4/ports";
import type { LeadStore } from "../stores/types";
import type { ScrapeJobRecord, ScrapeJobStore } from "./jobs";
import { primaryEmail } from "./extract";
import type { ScrapeOutcome } from "./scrapePage";

export interface ScrapeProcessorDeps {
  jobs: ScrapeJobStore;
  leads: LeadStore;
  scrape: (url: string) => Promise<ScrapeOutcome>;
  log: Log;
}

export function leadNameFromPage(title: string, host: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return (t || host).slice(0, 120);
}

/** Runs one claimed job to a final state. Never throws: every failure is recorded on the job. */
export async function processScrapeJob(job: ScrapeJobRecord, deps: ScrapeProcessorDeps): Promise<void> {
  try {
    const outcome = await deps.scrape(job.url);
    if (!outcome.ok) {
      await deps.jobs.fail(job.id, outcome.reason, outcome.message);
      deps.log.info({ jobId: job.id, reason: outcome.reason }, "scrape finished without a lead");
      return;
    }
    const host = new URL(outcome.finalUrl).hostname.replace(/^www\./, "");
    const email = primaryEmail(outcome.emails);
    const { lead, created } = await deps.leads.upsertScraped({
      ownerId: job.ownerId,
      name: leadNameFromPage(outcome.title, host),
      company: host,
      website: outcome.finalUrl,
      email,
      emails: outcome.emails,
      source: "Website scraper",
    });
    await deps.jobs.complete(job.id, { title: outcome.title, emails: outcome.emails, leadId: lead.id, leadCreated: created });
    deps.log.info({ jobId: job.id, leadId: lead.id, created, emails: outcome.emails.length }, "scrape finished");
  } catch (error) {
    deps.log.error({ jobId: job.id, error: String(error) }, "scrape job crashed");
    await deps.jobs.fail(job.id, "FAILED", "Something went wrong while scraping this page").catch(() => undefined);
  }
}
