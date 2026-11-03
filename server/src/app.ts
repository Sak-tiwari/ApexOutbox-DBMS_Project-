import express, { type ErrorRequestHandler, type Express } from "express";
import { randomUUID } from "node:crypto";
import { AuthService } from "./auth/service.js";
import type { Config } from "./config.js";
import { pingDb, type Db } from "./db/pool.js";
import path from "node:path";
import { createAccountRouter } from "./routes/account.js";
import { corsAllowlist, securityHeaders } from "./http/security.js";
import { rateLimit } from "./http/rateLimit.js";
import { AppError, TooManyRequestsError } from "./errors.js";
import type { Log } from "./logger.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createAuthRouter } from "./routes/auth.js";
import { createMeRouter } from "./routes/me.js";
import { ClientsService } from "./clients/service.js";
import { EmailService } from "./email/service.js";
import { InvoiceStorage } from "./invoices/storage.js";
import { InvoicesService } from "./invoices/service.js";
import { createClientsRouter, createEmailsRouter, createInvoicesRouter } from "./routes/billing.js";
import type { RealtimeHub } from "./realtime/hub.js";
import { createEventsRouter } from "./routes/events.js";
import { createScrapeRouter } from "./routes/scrape.js";
import { ScrapeService } from "./scraper/service.js";
import { createLeadsRouter } from "./routes/leads.js";
import { createUsersRouter } from "./routes/users.js";
import { LeadsService } from "./leads/service.js";
import { UsersService } from "./users/service.js";

export interface AppDeps {
  db: Db;
  log: Log;
  config: Config;
  /** Test hook: clock for the rate limiters. */
  now?: () => number;
  /** Called when a scrape job is queued, so the worker can start without waiting for its next poll. */
  onJobQueued?: () => void;
  /** Called when an e-mail is queued, so the worker sends without waiting for its next poll. */
  onEmailQueued?: () => void;
  /** Share one InvoicesService (and its PDF storage) with the e-mail worker. */
  invoices?: InvoicesService;
  /** Live-update hub. Without one, GET /api/events is not mounted. */
  hub?: RealtimeHub;
  /** Test hooks for the event stream. */
  streamOptions?: { maxStreamMs?: number; heartbeatMs?: number };
}

async function withDeadline(work: Promise<boolean>, ms: number): Promise<boolean> {
  return Promise.race([work, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}

export function createApp(deps: AppDeps): Express {
  const { db, log, config } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY);
  app.use(securityHeaders(config));
  app.use(corsAllowlist(config));
  // Coarse per-IP ceiling on everything (health checks excluded). Sensitive routes have tighter limits of their own.
  const globalLimit = rateLimit({ name: "global", limit: 600, windowMs: 60_000, now: deps.now });
  app.use((req, res, next) => (req.path === "/health" || req.path === "/ready" ? next() : globalLimit(req, res, next)));
  app.use(express.json({ limit: "100kb" }));

  // Request id + access log. Only method, path (no query string), status and timing are logged.
  app.use((req, res, next) => {
    const id = req.header("x-request-id")?.slice(0, 100) || randomUUID();
    res.setHeader("x-request-id", id);
    const started = Date.now();
    res.on("finish", () => {
      log.info({ id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started }, "request");
    });
    next();
  });

  // Liveness: the process is up. Never touches dependencies.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: dependencies reachable. Point load balancers here.
  app.get("/ready", async (_req, res) => {
    const up = await withDeadline(pingDb(db), 2000);
    res.status(up ? 200 : 503).json({ status: up ? "ready" : "degraded", checks: { database: up ? "up" : "down" } });
  });

  const authService = new AuthService(db, config, log);
  const auth = createAuthMiddleware({ db, config });
  app.use("/api/auth", createAuthRouter({ config, service: authService, auth, now: deps.now }));
  app.use("/api", createMeRouter({ db, auth }));
  app.use("/api/users", createUsersRouter({ service: new UsersService(db, authService), auth }));

  app.use("/api/leads", createLeadsRouter({ service: new LeadsService(db), auth, now: deps.now, onEmailQueued: deps.onEmailQueued }));

  const invoices = deps.invoices ?? new InvoicesService(db, new InvoiceStorage(config.INVOICE_STORAGE_DIR));
  if (deps.hub) app.use("/api/events", createEventsRouter({ hub: deps.hub, auth, ...deps.streamOptions }));
  app.use("/api", createAccountRouter({ db, auth, authService, now: deps.now }));
  app.use("/api/clients", createClientsRouter({ service: new ClientsService(db), auth }));
  app.use("/api/invoices", createInvoicesRouter({ service: invoices, auth, onEmailQueued: deps.onEmailQueued }));
  app.use("/api/emails", createEmailsRouter({ service: new EmailService(db), auth, onEmailQueued: deps.onEmailQueued }));
  app.use("/api/scrape", createScrapeRouter({ service: new ScrapeService(db), auth, onJobQueued: deps.onJobQueued, now: deps.now }));

  if (config.WEB_DIST_DIR) {
    const dir = path.resolve(config.WEB_DIST_DIR);
    app.use(express.static(dir, { index: false, maxAge: "1y", immutable: true, setHeaders: (res, file) => { if (/(index\.html|sw\.js|registerSW\.js|manifest\.webmanifest|theme\.js)$/.test(file)) res.setHeader("Cache-Control", "no-cache"); } }));
    // Single-page app: any other GET that is not the API serves the shell.
    app.get(/^\/(?!api\/).*/, (_req, res) => { res.setHeader("Cache-Control", "no-cache"); res.sendFile(path.join(dir, "index.html")); });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof AppError) {
      if (err instanceof TooManyRequestsError && err.retryAfterSeconds) res.setHeader("Retry-After", String(err.retryAfterSeconds));
      res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
      return;
    }
    const type = (err as { type?: string } | null)?.type;
    if (type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Request body is not valid JSON" } });
      return;
    }
    if (type === "entity.too.large") {
      res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" } });
      return;
    }
    // Unknown error: log the detail, never send it to the client.
    log.error({ err: String(err), path: req.path }, "unhandled error");
    res.status(500).json({ error: { code: "INTERNAL", message: "Internal server error" } });
  };
  app.use(errorHandler);

  return app;
}
