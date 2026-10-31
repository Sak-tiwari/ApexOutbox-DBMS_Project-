=====================================================================
 ApexOutbox (DBMS Project) - PHASE 1: ARCHITECTURE & FOUNDATION
=====================================================================

WHAT THIS PROJECT IS
--------------------
ApexOutbox is a system that:
  1. scrapes business leads from permitted sources (using Crawlee),
  2. moves them through a sales pipeline
     (New > Contacted > Follow-up > Negotiation > Closed-Won / Closed-Lost),
  3. when a lead becomes Closed-Won, creates a client, generates an invoice
     PDF and emails it - without ever losing or duplicating that work.

The name comes from the main database idea in the project: the
TRANSACTIONAL OUTBOX pattern (explained below).

This package is Phase 1 only (Days 1-2 of the 14-day plan): the design
and the starting code. No scraping, pipeline API, PDF or email exists yet.


WHAT IS INSIDE THIS FOLDER
--------------------------
README.txt                      This file.
docs/
  01-architecture.md            Architecture, workflow, failure handling.
  02-schema-spec.md             ER diagram, 7 collections, indexes, DBMS notes.
  03-decision-log.md            20 decisions: what, alternatives, why.
  04-api-contracts.md           Every API route, error codes, Zod schemas.
  05-event-contracts-and-state-machine.md
                                Pipeline rules, Closed-Won transaction,
                                outbox event shape, idempotency table.
  06-acceptance-checklist.md    What is done, what you must verify.
  07-licence-inventory.md       Third-party licences (starter list).
repo/                           The TypeScript project skeleton.
  src/config/env.ts             Environment validation (Zod).
  src/domain/pipeline.ts        Pipeline state machine (pure logic).
  src/domain/normalize.ts       Lead normalisation + duplicate key.
  src/models/                   7 Mongoose models with indexes.
  src/api/                      Express app + /health and /ready.
  src/server.ts, src/worker.ts  Two separate processes (API, worker).
  tests/                        20 starter tests.
  docker-compose.yml            MongoDB (replica set) + Redis for local use.
  .env.example                  Copy to .env.


HOW TO RUN IT
-------------
Requirements: Node.js 20+, Docker.

  cd repo
  cp .env.example .env
  docker compose up -d            (starts MongoDB replica set + Redis)
  npm install
  npm test                        (should show 20 passing tests)
  npm run typecheck
  npm run dev:api                 then open http://localhost:3000/ready
  npm run dev:worker              (in a second terminal)

If the MongoDB replica set says "not initialised", wait ~10 seconds and
run docker compose ps again; the healthcheck initialises it.


WHAT WAS VERIFIED
-----------------
Verified while building this package:
  - TypeScript compiles with no errors (npm run typecheck).
  - 20 tests pass (npm test): pipeline rules, normalisation and
    duplicate keys, environment validation, health endpoints.

NOT verified (needs your machine, listed in docs/06-acceptance-checklist.md):
  - Docker start-up of MongoDB and Redis.
  - The API and worker actually connecting to them.
  - Index creation in a real MongoDB.
The models and indexes follow the schema document, but they have not been
run against a live database yet.


THE CHOICES WE MADE, AND WHY
----------------------------
You asked me to choose the open requirements. Short version below; the
full table with alternatives is in docs/03-decision-log.md.

1. Internal use first, tenantId everywhere.
   Building a full multi-customer SaaS now would add billing and admin
   work you do not need yet. But adding a tenant field later means
   rewriting every query and index, so every document carries tenantId
   from day 1 and there is one tenant called "internal". Cheap now,
   expensive later.

2. MongoDB as a replica set (even on your laptop).
   MongoDB only supports multi-document transactions on a replica set.
   The outbox guarantee depends on a transaction, so we need it.

3. The transactional outbox pattern.
   Problem: when a lead is won, we must save the client AND tell the
   queue to make an invoice. If the app crashes between those two steps,
   you get a client with no invoice. Solution: save the client and an
   "event to send" row in ONE transaction. A separate dispatcher reads
   pending events and sends them to the queue. If anything crashes, the
   event is still safely in the database. This is the main DBMS concept
   of the project.

4. Unique indexes instead of "check then insert".
   Checking "does it exist?" and then inserting has a race condition.
   A unique index cannot be raced. So: one client per lead, one invoice
   per conversion, one outbox event per fact are all enforced by the
   database itself. Retries become harmless.

5. Closed-Won is final; Closed-Lost can be reopened (with a reason).
   A won lead already has a client and invoice; reopening it would need
   credit notes, which are out of scope. Closed-Lost has no side
   effects, so reopening it is safe, and every reopen is recorded in
   the audit log.

6. Version number on every lead (optimistic concurrency).
   If two people edit the same lead, the second one gets a clear
   "409 VERSION_CONFLICT" instead of silently overwriting the first.

7. Lead identity = website domain, then business email domain, then phone.
   Names are unreliable ("Acme Pvt Ltd" vs "ACME"). Domains are stable.
   Free email domains like gmail.com never identify a business. Leads
   with no reliable identity are saved and flagged for manual review
   instead of being guessed.

8. Money as whole paise (integers), tax as basis points.
   Decimal fractions cause rounding errors on invoices. Integers are
   exact.

9. Custom pipeline, not an embedded CRM.
   Our pipeline has six states. A CRM would bring licence obligations
   (EspoCRM is AGPL; Twenty has mixed licensing) and far more code than
   we need. Invoice Ninja is excluded for the same licensing reason.

10. PDFKit for invoices (Invoify only as a design reference).
    PDFKit makes PDFs directly, with no browser and no network access,
    which removes a class of security problems with HTML-to-PDF tools.

11. Email timeouts are "uncertain", not "failed".
    If an email request times out, we do not know if it was sent.
    Retrying blindly could send the invoice twice. We mark it uncertain
    and check with the provider first.

12. Crawlee with CheerioCrawler by default.
    As your updated plan says. Cheerio is light and fast; Playwright
    (a real browser) is only used if a source truly needs JavaScript.

13. Two processes, one codebase (API and worker).
    The API stays responsive because scraping, PDFs and email never run
    inside it.

14. Pure logic kept separate from the database.
    The pipeline rules and normalisation have no database code, so they
    are tested in milliseconds without MongoDB running.


THINGS WE DELIBERATELY DID NOT DO IN PHASE 1
--------------------------------------------
  - No scraper (Phase 2), no pipeline API or login (Phase 3), no
    invoice/email (Phase 4). The plan puts them in later phases.
  - No payment gateway: requirements are not confirmed.
  - No real invoice numbers or tax rules: we need your invoice
    requirements first.
  - The Closed-Won transaction is fully specified in
    docs/05-event-contracts-and-state-machine.md but not coded yet,
    because it should be written together with its integration tests
    against a real MongoDB in Phase 3.


WHAT I NEED FROM YOU BEFORE PHASE 2
-----------------------------------
  1. The first source to scrape (and its terms/robots.txt rules).
  2. Your existing scraper code, if you want it reviewed for reuse.
  3. Invoice details: your company info, tax (e.g. GST), numbering.
  4. If you will host this for other businesses: shared hosting or
     separate installs per customer.


NOTES
-----
  - The licence inventory is engineering guidance, not legal advice.
    Licences listed are what the projects advertise; verify exact
    versions before release.
  - Folder name: you wrote "ApexOutbox(DBMS Project Phase 1" without a
    closing bracket; I added one so the name is valid and balanced.
=====================================================================
