# ApexOutbox-DBMS_Project-
An automated business platform powered by Crawlee, Node.js, and TypeScript for web scraping. It features a custom sales pipeline state machine and a Redis/BullMQ outbox engine to automate lead ingestion, client onboarding, PDF invoicing, and email delivery.




# Business Automation System — Phase 4

## Lead scraper (Phase 2, now part of the app)
Paste a business website into the dashboard's **Find leads** box (or `POST /api/scrape-jobs {"url": "..."}`).
The API only queues the job; the worker loop picks it up, reads the page with Crawlee, collects the contact
emails and creates one lead in **New** (one lead per website and contact, scraping again never duplicates).
When you close that lead as Won, the client email is pre-filled from what the scraper found.

- Polite: obeys `robots.txt`, identifies itself as `ApexOutboxBot`, one page at a time.
- Safe: refuses localhost, private networks and cloud-metadata addresses, and re-checks every redirect.
- Scope: it reads the address you give **plus up to two Contact/About pages of the same website**, and collects emails and phone numbers (tel: links and numbers labelled Phone/Call/Mobile). It is not a directory crawler and it does not search for businesses by itself: you give it the website.
- Demo: three fake business pages and one page blocked by robots.txt live in `public/demo/` (buttons in the dashboard).
  They are only reachable by the scraper when `SCRAPER_ALLOW_LOOPBACK` is on (default outside production).

## Lead Finder (find clients who are asking for work)

The **Lead Finder** tab is the reverse of the website scraper: instead of listing businesses, it finds *requests*:
people and companies posting that they need a website, a logo, an app and so on, so you can pitch them.

1. **Service profile**: describe your business in plain words. Keywords and synonyms are extracted (no LLM: a stop-word list
   plus a synonym map in `src/leadFinder/keywords.ts`). You can edit them.
2. **Auto** (one click, uses your keywords) or **Manual** (type a query) with filters: platforms, budget range, posted within
   24h/7d/30d, location, remote only, experience level.
3. The API only queues the search. The worker runs every chosen source in parallel; each source has its own status chip
   (searching / done / blocked / failed) and one failing source never fails the search.
4. Results are scored 0-100 against your keywords (title hits count most, then description, plus freshness), de-duplicated
   (the same request on two platforms is one row with both links) and sortable.
5. Per result: **Add to pipeline** (creates a `New` lead with the post link, safe to click twice), **Save**, **Dismiss**, **Open post**.
6. **Saved searches** re-run on a schedule (1 h / 6 h / 24 h) in the worker; new matches show as a badge on the tab.

Contact is through the original post (the link), because the platforms do not publish emails or phone numbers.

**Sources:** Reddit (r/forhire, r/slavelabour, r/DoneDirtCheap), RemoteOK, Remotive and We Work Remotely, all through their public
JSON/RSS feeds. Fiverr, Upwork, Glassdoor, Indeed and LinkedIn are deliberately not included: they forbid scraping and require
logins or CAPTCHAs, which this project does not bypass.

**Demo mode:** set `LEAD_FINDER_MOCK=true` in `.env` (then restart). Only realistic *sample* requests are used, so a demo never depends on
the internet or on a site blocking us. The tab shows a "Demo mode" banner. `LEAD_FINDER_DISABLED_SOURCES=reddit,remoteok` switches live sources off.

**Hygiene** (one place: `src/leadFinder/http.ts`): identifying user agent, 12 s timeout, 2 retries with exponential backoff for network errors and 5xx,
1 s minimum gap per host, 3 MB size cap, 10-minute cache for identical requests, HTTP 401/403/429 reported as "blocked" and never retried.

### Add a new source

1. Create `src/leadFinder/sources/mysite.ts`:
   ```ts
   import type { LeadSource } from "../types";
   export function mySiteSource(): LeadSource {
     return {
       id: "mysite", name: "My Site",
       async search({ keywords, filters }, ctx) {
         const json = JSON.parse(await ctx.get("https://mysite.example/api/jobs"));   // ctx.get = polite HTTP
         return json.jobs.map((j: any) => ({
           externalId: String(j.id), title: j.title, url: j.link, company: j.company,
           description: j.text, budgetText: j.pay, location: j.where, remote: true, postedAt: new Date(j.date),
         }));
       },
     };
   }
   ```
   Throw `SourceBlockedError` if the site refuses automated access.
2. Add `mySiteSource()` to `liveSources()` in `src/leadFinder/sources/index.ts`. Scoring, filters, de-duplication, the status chip and the UI need no change.
3. Add a test in `tests/unit/lead-finder-sources.test.ts` with a sample of the site's real response.

Data model (MongoDB): `serviceprofiles` (one per user), `leadsearches` (a saved search is the same document with `saved: true`),
`foundleads` with a **unique index on (ownerId, source, externalId)**. Every query includes the owner id.

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

## Open the app (Windows, one click)
The app has a browser dashboard (board, new lead, deal form, invoices with PDF download), served by the API itself.

1. One-time setup: `npm ci`, then create `.env` (see Quick start; keep it named exactly `.env`).
2. Double-click **`start-apexoutbox.bat`**. It starts the API and the worker in two minimised windows, waits until MongoDB and Redis are reachable, and opens `http://localhost:3000`.
3. Paste your API key (the part before the colon in `API_KEYS`) on the first screen. The browser remembers it.
4. To stop everything, double-click **`stop-apexoutbox.bat`**.

Desktop shortcut with a hotkey: right-click `start-apexoutbox.bat`, **Send to > Desktop (create shortcut)**, then right-click the shortcut, **Properties**, click in **Shortcut key** and press for example `Ctrl+Alt+A`.

The page: drag a card to the next column (or use the arrow buttons). Moving to **Closed-Won** asks for the deal (email, amount) and then creates the client, the invoice and the PDF and sends the email; the invoice table shows each step live. With no `SMTP_*` settings the email step is a **demo** (the page says so); nothing is really sent.
`node scripts/ui-check.js` runs a 24-step browser test of the page against a running stack (see the file header).

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
| `GET /api/invoices?leadId=&limit=` | invoices (newest first) with status; `GET /api/invoices/:id/pdf` streams the PDF |
| `GET /api/meta` | the allowed pipeline moves and whether email is `smtp` or `demo` |
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
