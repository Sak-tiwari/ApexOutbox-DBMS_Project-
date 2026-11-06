import type { LeadSource } from "../types";
import { mockSource } from "./mock";
import { redditSource } from "./reddit";
import { remoteOkSource } from "./remoteok";
import { remotiveSource } from "./remotive";
import { weWorkRemotelySource } from "./weworkremotely";

/**
 * Every source the Lead Finder can use. To add one: create sources/<name>.ts that returns a LeadSource and
 * add it to LIVE_SOURCES. To turn one off, remove it from the list (or set LEAD_FINDER_DISABLED_SOURCES).
 *
 * Sites that forbid scraping or require a login (Fiverr, Upwork, Glassdoor, Indeed, LinkedIn) are
 * deliberately NOT included.
 */
export function liveSources(disabled: string[] = []): LeadSource[] {
  return [redditSource(), remoteOkSource(), remotiveSource(), weWorkRemotelySource()].filter((s) => !disabled.includes(s.id));
}

/** Sources used for a run. With mock mode on, only the sample data runs, so a demo never depends on the internet. */
export function activeSources(opts: { mock: boolean; disabled?: string[]; live?: LeadSource[] }): LeadSource[] {
  return opts.mock ? [mockSource()] : opts.live ?? liveSources(opts.disabled);
}
