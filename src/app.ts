import express, { type ErrorRequestHandler, type Express } from 'express';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors';
import { apiKeyAuth } from './middleware/auth';
import { rateLimit } from './middleware/rateLimit';
import { createLeadRouter, type LeadRouterDeps } from './routes/leadRoutes';
import path from 'node:path';
import { createOnboardingRouter } from './phase4/api';
import { ALLOWED_TRANSITIONS } from './services/TransitionService';
import { createInvoiceRouter, type InvoiceReader } from './routes/invoiceRoutes';
import type { Log } from './phase4/ports';
import type { Metrics } from './metrics';

export interface AppDeps extends LeadRouterDeps {
  apiKeys: Map<string, string>;
  /** Dependency probes for /ready. */
  checks: { mongo: () => Promise<boolean> | boolean; redis: () => Promise<boolean> | boolean };
  /** Business gauges for /metrics (pending outbox events, uncertain emails, ...). */
  gauges?: () => Promise<Record<string, number>>;
  log: Log;
  metrics: Metrics;
  /** Requests per minute per client IP on /api. Omit or 0 to disable. */
  rateLimitPerMinute?: number;
  /** Enables GET /api/invoices and the PDF download. */
  invoices?: InvoiceReader;
  invoiceDir?: string;
  /** Folder with the browser UI (index.html). Served at /. Omit to serve the JSON hello instead. */
  publicDir?: string;
  /** Shown in the UI so nobody mistakes demo mode for real delivery. */
  emailMode?: 'smtp' | 'demo';
}

async function probe(fn: () => Promise<boolean> | boolean): Promise<boolean> {
  try {
    return await Promise.race([
      Promise.resolve(fn()),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
  } catch {
    return false;
  }
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // Request id + access log + request counter.
  app.use((req, res, next) => {
    const id = req.header('x-request-id') || randomUUID();
    res.setHeader('x-request-id', id);
    const started = Date.now();
    res.on('finish', () => {
      deps.metrics.inc('apexoutbox_http_requests_total', { status: `${Math.floor(res.statusCode / 100)}xx` });
      deps.log.info({ id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started }, 'request');
    });
    next();
  });

  if (deps.publicDir) {
    // The page is public (it asks for the API key itself); every /api call is still authenticated.
    app.use(express.static(path.resolve(deps.publicDir), {
      index: 'index.html',
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'self'; frame-ancestors 'self'");
      },
    }));
  } else {
    app.get('/', (_req, res) => {
      res.json({ message: 'ApexOutbox API is running' });
    });
  }

  // Liveness: process is up. Never touches dependencies.
  app.get('/health', (_req, res) => {
    res.json({ status: 'OK' });
  });

  // Readiness: dependencies reachable. Point load balancers here.
  app.get('/ready', async (_req, res) => {
    const [mongo, redis] = await Promise.all([probe(deps.checks.mongo), probe(deps.checks.redis)]);
    const ready = mongo && redis;
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', checks: { mongo: mongo ? 'up' : 'down', redis: redis ? 'up' : 'down' } });
  });

  const auth = apiKeyAuth(deps.apiKeys);

  app.get('/metrics', auth, async (_req, res) => {
    res.type('text/plain').send(await deps.metrics.render(deps.gauges));
  });

  app.use('/api', rateLimit({ limit: deps.rateLimitPerMinute ?? 0 }));
  app.use('/api/leads', auth, createLeadRouter(deps));
  app.get('/api/meta', auth, (_req, res) => {
    res.json({ success: true, data: { transitions: ALLOWED_TRANSITIONS, reasonRequiredFrom: ['Closed-Won', 'Closed-Lost'], emailMode: deps.emailMode ?? 'demo' } });
  });
  if (deps.invoices) app.use('/api/invoices', auth, createInvoiceRouter({ invoices: deps.invoices, invoiceDir: deps.invoiceDir ?? 'generated-invoices' }));
  app.use('/api/phase4', auth, createOnboardingRouter());

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: 'Route not found', code: 'NOT_FOUND' });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ success: false, error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
    }
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      return res.status(400).json({ success: false, error: 'Request body is not valid JSON', code: 'VALIDATION_ERROR' });
    }
    if ((err as { type?: string })?.type === 'entity.too.large') {
      return res.status(413).json({ success: false, error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' });
    }
    // Unknown error: log the detail, never send it to the client.
    deps.log.error({ error: String(err), path: req.path }, 'unhandled error');
    return res.status(500).json({ success: false, error: 'Internal server error', code: 'INTERNAL' });
  };
  app.use(errorHandler);

  return app;
}
