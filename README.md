# ApexOutbox-DBMS_Project-
An automated business platform powered by Crawlee, Node.js, and TypeScript for web scraping. It features a custom sales pipeline state machine and a Redis/BullMQ outbox engine to automate lead ingestion, client onboarding, PDF invoicing, and email delivery.




# Business Automation System — Phase 4

## Overview
Phase 4 automates client onboarding, invoice creation,
PDF generation, and transactional email processing.

## Technologies
- Node.js and TypeScript
- Express.js for the API
- MongoDB and Mongoose
- Redis and BullMQ for background jobs
- PDFKit for invoice PDF generation
- Nodemailer for email delivery
- Zod for input validation

## Main Components
- `src/phase4/api.ts` — onboarding API endpoint
- `src/phase4/onboarding.ts` — input validation and idempotency key
- `src/phase4/models.ts` — client and invoice database models
- `src/phase4/invoice.ts` — invoice PDF generation
- `src/phase4/email.ts` — email delivery and demo mode
- `src/phase4/queue.ts` — background job queue
- `src/phase4/outbox.ts` — durable outbox event model
- `src/phase4/dispatcher.ts` — dispatches outbox events to BullMQ
- `src/phase4/worker.ts` — processes invoice jobs
- `src/phase4/types.ts` — shared TypeScript interfaces

## Workflow
1. A lead is marked Closed-Won in the sales pipeline.
2. The onboarding API validates client information.
3. Client and invoice records are created or retrieved.
4. An outbox event is recorded for processing.
5. The dispatcher publishes the event to BullMQ.
6. The worker generates the invoice PDF.
7. The worker attempts to email the invoice.

## Environment Configuration
Copy `.env.example` to `.env` in the local development
environment and configure MongoDB, Redis, and optional
SMTP credentials. Never commit real secrets.

## Development Commands
Install dependencies with `npm install`.

Build TypeScript with `npm run build`.

Start the API with `npm run start:api`.

Start the dispatcher with `npm run start:dispatcher`.

Start the worker with `npm run start:worker`.

MongoDB and Redis must be available before starting
the application.

## Important Limitations
This is a development prototype and requires integration
with the shared Phase 1–3 application.

Before production use, implement and test:
- Atomic invoice and outbox transactions
- Outbox recovery after worker crashes
- Authentication and authorization
- Reliable email timeout reconciliation
- Durable PDF storage
- Integration, retry, and duplicate-processing tests

---

# Phase 5 - QA, hardening and release candidate (`1.0.0-rc.1`)

Phase 3 (lead pipeline) and Phase 4 (onboarding, invoice, email) are now one application, with tests and an ops runbook.

## Quick start
```
npm ci
cp .env.example .env        # set MONGODB_URI, REDIS_URL, API_KEYS
npm run typecheck && npm test
npm run dev                 # API
npm run dev:worker          # worker (invoices, outbox dispatcher, reconciler, requeue sweep)
```

## How the phases connect
1. `POST /api/leads/:id/transition` with `targetState: "Closed-Won"` **requires a `deal`**
   (`email`, `amount`, `currency`, `description`). It is saved in the same single-document update as the state change.
2. The hand-off creates one client and one invoice (idempotent per lead) and writes an outbox event.
   If that fails the lead stays `onboardingStatus: PENDING` and the worker's reconciler retries.
3. The dispatcher publishes the event to BullMQ (jobId per invoice), the worker builds the PDF and sends the email
   **at most once**. A timeout becomes `EMAIL_UNCERTAIN` and waits for a human (see the runbook).

All API routes now need `Authorization: Bearer <key>` (keys from `API_KEYS`).

| Route | Purpose |
|---|---|
| `POST /api/leads` | create a lead `{name, company, followUpDate?}`; the key's user becomes the owner |
| `GET /api/leads` | list; `state`, `ownerId`, `followUpBefore/After`, `limit` (1-100, default 25), `cursor` -> `nextCursor` |
| `GET /api/leads/:id` | one lead with its history |
| `POST /api/leads/:id/transition` | `{targetState, version, reason?, deal?}` (`version` may be a number or digit string) |
| `GET /health`, `GET /ready`, `GET /metrics` | liveness, readiness (Mongo + Redis), metrics (key required) |

`RATE_LIMIT_PER_MINUTE` (default 300 per client IP) limits `/api`. `npm run ci` = typecheck + full tests with skips as errors + build.

## Layout (changed from `main`)
Phase 3 files moved into `src/models`, `src/services`, `src/routes`, `src/tests`, `src/app.ts`, `src/server.ts`
(the folders their imports and `package.json` already expected). **Teammates: pull/rebase before editing.**

Phase 4 modules changed shape (same behaviour, now testable): `api.ts` exports a router instead of its own server, `queue.ts` is a
factory (`createQueueClient`), and `worker.ts` / `dispatcher.ts` are thin runners over `processor.ts` and `dispatcherCore.ts`.
New combined entry points: `src/server.ts` (API) and `src/worker.ts` (everything background).

## Docs
- `docs/phase5/PHASE5-FINDINGS.md` - defects found and fixed, decisions still open, what could not be verified
- `docs/phase5/TEST-REPORT.md` - what ran, results, honest limits
- `docs/phase5/RUNBOOK.md` - setup, deployment, monitoring, recovery steps, backup/restore
- `THIRD_PARTY_NOTICES.md` - licences of production dependencies (`npm run notices`)
