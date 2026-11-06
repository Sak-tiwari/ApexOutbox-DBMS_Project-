import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { cleanKeywordList, extractKeywords, keywordsFromQuery } from "../leadFinder/keywords";
import type { FoundRecord, FoundStatus } from "../leadFinder/models";
import type { LeadFinderStore } from "../leadFinder/store";
import type { LeadSource } from "../leadFinder/types";
import type { LeadStore } from "../stores/types";

export const MAX_ACTIVE_SEARCHES_PER_USER = 5;

const filters = z.object({
  platforms: z.array(z.string().regex(/^[a-z0-9-]{1,30}$/)).max(10).optional(),
  budgetMin: z.number().min(0).max(1e9).optional(),
  budgetMax: z.number().min(0).max(1e9).optional(),
  postedWithin: z.enum(["24h", "7d", "30d"]).optional(),
  location: z.string().trim().max(60).optional(),
  remoteOnly: z.boolean().optional(),
  level: z.enum(["entry", "mid", "senior"]).optional(),
}).strict();

const profileBody = z.object({ description: z.string().trim().min(5, "Describe what your business offers (at least a few words)").max(2000), keywords: z.array(z.string()).max(30).optional() });
const searchBody = z.object({
  mode: z.enum(["auto", "manual"]),
  query: z.string().trim().max(200).optional(),
  keywords: z.array(z.string()).max(30).optional(),
  filters: filters.default({}),
  save: z.object({ name: z.string().trim().min(1).max(80), everyHours: z.number().int().min(0).max(168) }).optional(),
});
const saveBody = z.object({ name: z.string().trim().min(1).max(80), everyHours: z.number().int().min(0).max(168).default(0) });
const resultQuery = z.object({
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  source: z.string().regex(/^[a-z0-9-]{1,30}$/).optional(),
  status: z.enum(["NEW", "SAVED", "DISMISSED", "PIPELINED", "ALL"]).optional(),
  sort: z.enum(["score", "date", "budget"]).optional(),
});

export interface LeadFinderRouterDeps {
  store: LeadFinderStore;
  leads: LeadStore;
  sources: LeadSource[];
  mock: boolean;
}

const invalid = (error: z.ZodError) => new ValidationError(error.issues[0]?.message ?? "Invalid request", error.issues);

/** Everything is scoped to req.userId: another user's ids behave exactly like ids that do not exist (404). */
export function createLeadFinderRouter(deps: LeadFinderRouterDeps): Router {
  const router = Router();
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
  const ok = (res: Response, data: unknown, status = 200, extra: object = {}) => res.status(status).json({ success: true, data, ...extra });

  router.get("/sources", wrap(async (_req, res) => ok(res, { mock: deps.mock, sources: deps.sources.map((s) => ({ id: s.id, name: s.name })) })));

  // ---- service profile ----
  router.get("/profile", wrap(async (req, res) => ok(res, await deps.store.getProfile(req.userId!))));
  router.post("/keywords/suggest", wrap(async (req, res) => {
    const p = z.object({ description: z.string().trim().min(3).max(2000) }).safeParse(req.body);
    if (!p.success) throw invalid(p.error);
    return ok(res, { keywords: extractKeywords(p.data.description) });
  }));
  router.post("/profile", wrap(async (req, res) => {
    const p = profileBody.safeParse(req.body);
    if (!p.success) throw invalid(p.error);
    const edited = cleanKeywordList(p.data.keywords);
    const keywords = edited.length ? edited : extractKeywords(p.data.description);
    if (keywords.length === 0) throw new ValidationError("Could not find any keywords in that description. Add a few words about your services.");
    return ok(res, await deps.store.saveProfile(req.userId!, p.data.description, keywords));
  }));

  // ---- searches ----
  router.post("/search", wrap(async (req, res) => {
    const p = searchBody.safeParse(req.body);
    if (!p.success) throw invalid(p.error);
    const { mode, filters: f, save } = p.data;
    if (f.budgetMin !== undefined && f.budgetMax !== undefined && f.budgetMin > f.budgetMax) throw new ValidationError("Minimum budget is higher than maximum budget");

    let keywords: string[];
    let query = p.data.query ?? "";
    if (mode === "auto") {
      const profile = await deps.store.getProfile(req.userId!);
      if (!profile) throw new ValidationError("Describe your business in the Service Profile first");
      keywords = cleanKeywordList(p.data.keywords).length ? cleanKeywordList(p.data.keywords) : profile.keywords;
      query = query || "Auto: my service profile";
    } else {
      if (!query) throw new ValidationError("Type what you are looking for");
      const given = cleanKeywordList(p.data.keywords);
      keywords = given.length ? given : keywordsFromQuery(query);
    }
    if (keywords.length === 0) throw new ValidationError("No keywords to search for");

    if ((await deps.store.countActive(req.userId!)) >= MAX_ACTIVE_SEARCHES_PER_USER) throw new ConflictError("Too many searches are still running. Wait a moment and try again.");
    const search = await deps.store.createSearch({ ownerId: req.userId!, mode, query, keywords, filters: f, saved: save });
    return ok(res, search, 202);
  }));

  router.get("/searches", wrap(async (req, res) => ok(res, await deps.store.listRecent(req.userId!, 10))));

  router.get("/search/:id", wrap(async (req, res) => {
    const search = await deps.store.getSearch(req.userId!, String(req.params.id));
    if (!search) throw new NotFoundError("Search not found");
    const q = resultQuery.safeParse(req.query);
    if (!q.success) throw invalid(q.error);
    const results = await deps.store.listResults(req.userId!, search.id, { ...q.data, status: q.data.status as FoundStatus | "ALL" | undefined });
    return ok(res, { search, results });
  }));

  router.post("/search/:id/save", wrap(async (req, res) => {
    const p = saveBody.safeParse(req.body);
    if (!p.success) throw invalid(p.error);
    const s = await deps.store.saveSearch(req.userId!, String(req.params.id), p.data.name, p.data.everyHours);
    if (!s) throw new NotFoundError("Search not found");
    return ok(res, s);
  }));

  router.get("/saved-searches", wrap(async (req, res) => ok(res, await deps.store.listSaved(req.userId!))));
  router.delete("/saved-searches/:id", wrap(async (req, res) => {
    if (!(await deps.store.deleteSaved(req.userId!, String(req.params.id)))) throw new NotFoundError("Saved search not found");
    return ok(res, { removed: true });
  }));
  router.post("/saved-searches/:id/run", wrap(async (req, res) => {
    const existing = await deps.store.getSearch(req.userId!, String(req.params.id));
    if (!existing || !existing.saved) throw new NotFoundError("Saved search not found");
    const again = await deps.store.rerun(req.userId!, existing.id);
    if (!again) throw new ConflictError("This search is already running");
    return ok(res, again, 202);
  }));

  // ---- notifications ----
  router.get("/summary", wrap(async (req, res) => ok(res, { unseen: await deps.store.unseenCount(req.userId!) })));
  router.post("/seen", wrap(async (req, res) => { await deps.store.markAllSeen(req.userId!); return ok(res, { unseen: 0 }); }));

  // ---- actions on a found lead ----
  const getFound = async (req: Request): Promise<FoundRecord> => {
    const f = await deps.store.getFound(req.userId!, String(req.params.id));
    if (!f) throw new NotFoundError("Lead not found");
    return f;
  };
  router.post("/leads/:id/save", wrap(async (req, res) => {
    const f = await getFound(req);
    if (f.status === "PIPELINED") return ok(res, f);
    return ok(res, await deps.store.setFoundStatus(req.userId!, f.id, "SAVED"));
  }));
  router.post("/leads/:id/dismiss", wrap(async (req, res) => {
    const f = await getFound(req);
    if (f.status === "PIPELINED") throw new ConflictError("This lead is already in your pipeline");
    return ok(res, await deps.store.setFoundStatus(req.userId!, f.id, "DISMISSED"));
  }));
  router.post("/leads/:id/pipeline", wrap(async (req, res) => {
    const f = await getFound(req);
    if (f.status === "PIPELINED" && f.leadId) return ok(res, { found: f, lead: await deps.leads.findById(f.leadId) });
    // dedupeKey makes this safe to click twice, or from two tabs: the second call returns the same lead.
    const lead = await deps.leads.create({
      ownerId: req.userId!,
      name: (f.title || "Lead Finder request").slice(0, 120),
      company: (f.company || f.sourceName).slice(0, 120),
      website: f.url,
      source: `Lead Finder: ${f.sourceName}`,
      dedupeKey: `lf|${req.userId}|${f.source}|${f.externalId}`,
    });
    const found = await deps.store.setFoundStatus(req.userId!, f.id, "PIPELINED", lead.id);
    return ok(res, { found, lead }, 201);
  }));

  return router;
}
