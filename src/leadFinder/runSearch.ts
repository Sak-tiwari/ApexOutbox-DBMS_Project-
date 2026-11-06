import type { Log } from "../phase4/ports";
import { matchesFilters } from "./filters";
import type { SearchRecord, SourceRun } from "./models";
import { scoreLead } from "./score";
import type { LeadFinderStore } from "./store";
import { SourceBlockedError, type LeadSource, type SourceContext } from "./types";

export const MIN_SCORE = 10;
const PER_SOURCE_TIMEOUT_MS = 45_000;

export interface RunDeps {
  store: LeadFinderStore;
  sources: LeadSource[];
  http: SourceContext;
  log: Log;
  now?: () => number;
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("the source took too long")), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Runs one claimed search: every chosen source in parallel, each isolated, so one that is blocked or
 * broken only changes its own status chip. Never throws; the search always ends DONE or FAILED.
 */
export async function runSearch(search: SearchRecord, deps: RunDeps): Promise<void> {
  const { store, log } = deps;
  const now = deps.now ?? Date.now;
  try {
    const wanted = search.filters.platforms?.length ? deps.sources.filter((s) => search.filters.platforms!.includes(s.id)) : deps.sources;
    if (wanted.length === 0) {
      await store.finish(search.id, { status: "FAILED", resultCount: 0, newCount: 0, error: "None of the selected platforms is available" });
      return;
    }
    const runs: SourceRun[] = wanted.map((s) => ({ id: s.id, name: s.name, status: "running", count: 0, error: "" }));
    await store.setSources(search.id, runs);
    const seen = !(await store.isScheduledRun(search.id));

    let created = 0;
    // Sources are fetched in parallel, but results are stored one at a time: otherwise the same request
    // arriving from two platforms at once could be inserted twice before either sees the other.
    let storing: Promise<unknown> = Promise.resolve();
    const storeSerially = <T>(fn: () => Promise<T>): Promise<T> => { const run = storing.then(fn); storing = run.catch(() => undefined); return run; };
    const results = await Promise.allSettled(wanted.map(async (source, i) => {
      try {
        const raws = await withTimeout(source.search({ keywords: search.keywords, filters: search.filters }, deps.http), deps.timeoutMs ?? PER_SOURCE_TIMEOUT_MS);
        let kept = 0;
        await storeSerially(async () => {
          for (const raw of raws) {
            if (!raw.externalId || !raw.title || !raw.url || !matchesFilters(raw, search.filters, now())) continue;
            const score = scoreLead(raw, search.keywords, now());
            if (score < MIN_SCORE) continue;
            const outcome = await store.upsertFound(search.ownerId, search.id, { id: source.id, name: source.name }, raw, score, seen);
            if (outcome === "created") created++;
            kept++;
          }
        });
        runs[i] = { ...runs[i], status: "done", count: kept };
      } catch (error) {
        const blocked = error instanceof SourceBlockedError;
        runs[i] = { ...runs[i], status: blocked ? "blocked" : "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
        log.warn({ source: source.id, blocked, error: runs[i].error }, "lead finder source did not finish");
      }
      await store.setSources(search.id, runs.map((r) => ({ ...r }))); // snapshot: the UI polls this to draw the status chips
    }));
    void results;

    const anyDone = runs.some((r) => r.status === "done");
    const total = runs.reduce((n, r) => n + r.count, 0);
    await store.finish(search.id, anyDone
      ? { status: "DONE", resultCount: total, newCount: created }
      : { status: "FAILED", resultCount: 0, newCount: 0, error: "Every source failed or was blocked" });
    log.info({ searchId: search.id, total, created, sources: runs.map((r) => `${r.id}:${r.status}`) }, "lead finder search finished");
  } catch (error) {
    log.error({ searchId: search.id, error: String(error) }, "lead finder search crashed");
    await store.finish(search.id, { status: "FAILED", resultCount: 0, newCount: 0, error: "Something went wrong while searching" }).catch(() => undefined);
  }
}
