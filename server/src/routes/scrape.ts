import { Router } from "express";
import { z } from "zod";
import { isUuid } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { limitSchema } from "../http/pagination.js";
import { rateLimit } from "../http/rateLimit.js";
import { parse } from "../http/validate.js";
import { authOf, type AuthMiddleware } from "../middleware/auth.js";
import { MAX_URLS_PER_JOB, type ScrapeService } from "../scraper/service.js";

const domainSchema = z.object({ domain: z.string().trim().min(3).max(253) }).strict();
const jobSchema = z
  .object({
    urls: z.array(z.string().trim().min(1).max(2000)).min(1).max(MAX_URLS_PER_JOB),
    idempotencyKey: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
  })
  .strict();
const listSchema = z.object({ limit: limitSchema, cursor: z.string().max(500).optional() });

const idOf = (raw: unknown, what: string) => {
  if (typeof raw !== "string" || !isUuid(raw)) throw new NotFoundError(`${what} not found`);
  return raw;
};

export function createScrapeRouter(deps: { service: ScrapeService; auth: AuthMiddleware; onJobQueued?: () => void; now?: () => number }) {
  const { service, auth } = deps;
  const router = Router();
  router.use(auth.requireAuth());
  // 10 new jobs per workspace per hour, whoever in the workspace starts them.
  const jobLimit = rateLimit({ name: "scrape-job", limit: 10, windowMs: 60 * 60_000, key: (req) => authOf(req).tenantId, now: deps.now });

  router.get("/domains", auth.requirePermission("scrape:run"), async (req, res) => {
    res.json(await service.listDomains(authOf(req)));
  });
  router.post("/domains", auth.requirePermission("scrape:manage_domains"), async (req, res) => {
    res.status(201).json(await service.addDomain(authOf(req), parse(domainSchema, req.body).domain, req.ip));
  });
  router.delete("/domains/:id", auth.requirePermission("scrape:manage_domains"), async (req, res) => {
    await service.removeDomain(authOf(req), idOf(req.params.id, "Domain"), req.ip);
    res.status(204).end();
  });

  router.post("/jobs", auth.requirePermission("scrape:run"), jobLimit, async (req, res) => {
    const { job, created } = await service.createJob(authOf(req), parse(jobSchema, req.body), req.ip);
    if (created) deps.onJobQueued?.();
    res.status(created ? 201 : 200).json(job);
  });
  router.get("/jobs", auth.requirePermission("scrape:run"), async (req, res) => {
    res.json(await service.listJobs(authOf(req), parse(listSchema, req.query, "Query")));
  });
  router.get("/jobs/:id", auth.requirePermission("scrape:run"), async (req, res) => {
    res.json(await service.getJob(authOf(req), idOf(req.params.id, "Scrape job")));
  });
  router.post("/jobs/:id/cancel", auth.requirePermission("scrape:run"), async (req, res) => {
    res.json(await service.cancelJob(authOf(req), idOf(req.params.id, "Scrape job"), req.ip));
  });
  return router;
}
