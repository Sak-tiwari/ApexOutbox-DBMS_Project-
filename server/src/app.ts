import express, { type ErrorRequestHandler, type Express } from "express";
import { randomUUID } from "node:crypto";
import { AuthService } from "./auth/service.js";
import type { Config } from "./config.js";
import { pingDb, type Db } from "./db/pool.js";
import { AppError, TooManyRequestsError } from "./errors.js";
import type { Log } from "./logger.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createAuthRouter } from "./routes/auth.js";
import { createMeRouter } from "./routes/me.js";
import { createUsersRouter } from "./routes/users.js";
import { UsersService } from "./users/service.js";

export interface AppDeps {
  db: Db;
  log: Log;
  config: Config;
  /** Test hook: clock for the rate limiters. */
  now?: () => number;
}

async function withDeadline(work: Promise<boolean>, ms: number): Promise<boolean> {
  return Promise.race([work, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}

export function createApp(deps: AppDeps): Express {
  const { db, log, config } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY);
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
