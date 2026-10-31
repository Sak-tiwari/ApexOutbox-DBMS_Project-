import express, { type Express } from "express";
import { healthRouter, type HealthChecks } from "./routes/health.js";

export function createApp(checks: HealthChecks): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter(checks));

  // Business routes (scrape jobs, leads, transitions, clients, invoices) arrive in Phases 2-4.
  // Contracts are fixed in docs/04-api-contracts.md.

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } });
  });

  return app;
}
