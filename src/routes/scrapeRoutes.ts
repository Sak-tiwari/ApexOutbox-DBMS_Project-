import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { checkUrl, type SafeUrlOptions } from "../scraper/safeUrl";
import type { ScrapeJobStore } from "../scraper/jobs";

const body = z.object({ url: z.string().trim().min(1).max(2000) });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

export const MAX_ACTIVE_SCRAPES_PER_USER = 10;

export interface ScrapeRouterDeps {
  jobs: ScrapeJobStore;
  safeUrl: SafeUrlOptions;
}

/**
 *   POST /api/scrape-jobs   { url }   -> 202 { data: job }  (the worker does the scraping)
 *   GET  /api/scrape-jobs?limit=      -> the caller's recent jobs, newest first
 *   GET  /api/scrape-jobs/:id
 */
export function createScrapeRouter(deps: ScrapeRouterDeps): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = body.safeParse(req.body);
      if (!parsed.success) throw new ValidationError("Enter the website address to scrape", parsed.error.issues);
      let raw = parsed.data.url;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`; // "example.com" -> https://example.com
      const check = await checkUrl(raw, deps.safeUrl);
      if (!check.ok) throw new ValidationError(check.reason);
      const url = check.url.toString();

      if ((await deps.jobs.countActive(req.userId!)) >= MAX_ACTIVE_SCRAPES_PER_USER) {
        throw new ConflictError("Too many scrapes are still waiting. Try again in a minute.");
      }
      const { job, created } = await deps.jobs.enqueue(req.userId!, url);
      return res.status(created ? 202 : 200).json({ success: true, data: job, alreadyQueued: !created });
    } catch (error) {
      next(error);
    }
  });

  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) throw new ValidationError("Invalid query parameters", parsed.error.issues);
      const data = await deps.jobs.list(req.userId!, parsed.data.limit);
      return res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await deps.jobs.findById(String(req.params.id));
      if (!job || job.ownerId !== req.userId) throw new NotFoundError("Scrape job not found");
      return res.status(200).json({ success: true, data: job });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
