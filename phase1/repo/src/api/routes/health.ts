import { Router } from "express";

export interface HealthChecks {
  mongo: () => Promise<boolean> | boolean;
  redis: () => Promise<boolean> | boolean;
}

async function safe(fn: () => Promise<boolean> | boolean): Promise<boolean> {
  try {
    return await fn();
  } catch {
    return false;
  }
}

export function healthRouter(checks: HealthChecks): Router {
  const router = Router();

  // Liveness: the process is up. Never touches dependencies.
  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: dependencies reachable. A load balancer should use this one.
  router.get("/ready", async (_req, res) => {
    const [mongo, redis] = await Promise.all([safe(checks.mongo), safe(checks.redis)]);
    const ready = mongo && redis;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "degraded",
      checks: { mongo: mongo ? "up" : "down", redis: redis ? "up" : "down" },
    });
  });

  return router;
}
