# ApexOutbox

A multi-tenant lead-scraping and client-management platform. Find leads, work them through a sales pipeline, and when one is **Closed-Won** the system creates the client, issues a numbered invoice (PDF) and e-mails it, all in one atomic step.

- **Frontend:** React 19, Vite, Tailwind, TanStack Query. Installable PWA, mobile-first (designed at 360 px), dark mode, live updates.
- **Backend:** Node 22, Express 5, PostgreSQL 16, Zod. JWT access token plus rotating httpOnly refresh cookie.
- **Isolation:** every row carries a `tenant_id`, enforced three ways: query filters, composite foreign keys, and PostgreSQL Row-Level Security.

Design decisions and their reasons are in [`docs/webapp/DECISIONS.md`](docs/webapp/DECISIONS.md); the schema is in [`docs/webapp/SCHEMA.md`](docs/webapp/SCHEMA.md). The earlier MongoDB/BullMQ implementation is kept for reference in `legacy/mongo/`.

## Features

| Area | What it does |
| --- | --- |
| Leads | Debounced server-side search and filters, keyset pagination with infinite scroll, list and board views, optimistic moves with rollback, CSV import (formula-injection safe), notes, activity history |
| Pipeline | State machine `NEW → CONTACTED → FOLLOW_UP → NEGOTIATION → CLOSED_WON / CLOSED_LOST`; Closed-Won is final, Closed-Lost can reopen to Follow-up with a reason; optimistic concurrency (`version`) |
| Scraper | Per-workspace domain allowlist, SSRF guard, robots.txt (RFC 9309), per-host throttling, live job progress, cancel/resume |
| Billing | Closed-Won creates client + gapless-numbered invoice + immutable snapshot + PDF + e-mail in one transaction. Money is integer minor units |
| E-mail | Postgres outbox, at-most-once sending, retries with backoff, an explicit "uncertain" state for unknown outcomes that a human resolves |
| Real time | Server-Sent Events fed by PostgreSQL `LISTEN/NOTIFY`: new leads, pipeline moves, invoice and e-mail status, scrape progress |
| Admin | Roles Owner/Admin/Member, user management, audit log, CSV export, optional TOTP 2FA, account and workspace deletion |

## Quick start (development)

Requirements: Node 22+, PostgreSQL 16+ (with `psql`).

```bash
npm ci
cp .env.example server/.env          # then fill in the two secrets and the DB passwords
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_ACCESS_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # TOTP_ENC_KEY

ADMIN_DATABASE_URL=postgres://postgres:...@localhost:5432/postgres \
APEX_OWNER_PASSWORD=... APEX_APP_PASSWORD=... npm run db:setup    # roles + database, once
npm run db:migrate

npm run dev:server     # API on :3000
npm run dev:web        # app on http://localhost:5173 (proxies /api to :3000)
```

Open http://localhost:5173 and create a workspace. In development e-mails are only logged (`EMAIL_MODE=log`).

## Tests

```bash
# one-time: a database whose name contains "test" (it is wiped on every run)
DB_NAME=apexoutbox_test ADMIN_DATABASE_URL=... APEX_OWNER_PASSWORD=... APEX_APP_PASSWORD=... bash scripts/db-setup.sh
# put TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL in server/.env.test (see .env.example)

npm test            # server (real PostgreSQL, no mocks) then web
npm run typecheck
npm run audit       # production dependencies
```

The server suite includes a cross-tenant sweep: a second tenant's OWNER tries every id-addressed route against the first tenant's records and must get an identical 404, and every list, stat and export must come back free of the other tenant's rows.

## Production

Terminate TLS in a reverse proxy and set `TRUST_PROXY` to the number of proxies in front. The API can also serve the built web app (`WEB_DIST_DIR`), which is what the Docker image does.

```bash
cp .env.example .env   # set secrets, ALLOWED_ORIGINS=https://your.domain, SMTP_*, EMAIL_MODE=smtp
export POSTGRES_ADMIN_PASSWORD=... APEX_OWNER_PASSWORD=... APEX_APP_PASSWORD=...
docker compose up -d db
docker compose run --rm migrate
docker compose up -d api
```

Production refuses to start with `EMAIL_MODE=log`, a non-https origin, an insecure cookie setting, or a database role that can bypass Row-Level Security. Back up the database **and** the invoice PDF volume together.

> The Docker files have been reviewed and `docker compose config` validates, but the image has not been built in the environment this was developed in (no Docker daemon). The compiled server and web build were run directly with `WEB_DIST_DIR` instead.

## Security summary

Argon2id passwords with a strength policy; rotating single-use refresh tokens with reuse detection and revocation; optional TOTP 2FA (secrets encrypted at rest) with recovery codes; account lockout and rate limits; server-side RBAC on every route (the UI only hides things); CSRF defence on cookie endpoints; strict CORS allowlist; Helmet with CSP and HSTS; parameterised SQL only; Zod validation on every input; CSV import and export neutralise spreadsheet formulas; scraper SSRF protection and robots.txt; append-only audit log; soft deletes; secrets only from environment variables and never logged.

## Known limits

- Rate limiters are in memory per process; with several API replicas put a gateway limiter in front.
- The scraper reads static HTML only (no JavaScript rendering).
- Invoice PDFs use a standard Latin-1 font; other scripts print as `?`.
- Deleted workspaces and users are soft-deleted (access ends immediately). Purging the rows after a retention period is an operational step that is not automated.
- A reload restores the session from the refresh cookie; offline, the app shell loads but data views show an error with retry (API responses are never cached).
