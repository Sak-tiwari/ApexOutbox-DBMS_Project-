# 03 - Decision log

Format: decision, alternatives considered, reason. Status is **Accepted** unless noted.
These were chosen by us in Phase 1 because the plan left them open ("choose the requirements as per your choice").

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| D-01 | Internal use first; hosted-for-others is a later option | Build full SaaS now | Avoids billing, onboarding and admin screens that do not help the first customer. Cheap insurance is kept via D-04. |
| D-02 | Crawlee as scraper framework; CheerioCrawler by default, Playwright only if a source needs JavaScript | Reuse the old scraper; Puppeteer; plain axios+cheerio | Chosen in the updated plan. Gives request queue, retries, concurrency and session handling for free. Cheerio is far lighter than a browser. |
| D-03 | MongoDB + Mongoose | PostgreSQL | Plan specifies MongoDB. Scraped data is irregular, and embedded documents (line items, provenance) fit well. Cost: no foreign keys, so we enforce integrity with unique indexes and transactions. |
| D-04 | `tenantId` on every document and first in every index, one seeded tenant | No tenant field now; separate database per customer | Adding it later means rewriting every query and index. Having it now costs almost nothing. |
| D-05 | MongoDB runs as a replica set, even locally | Standalone server | Transactions need a replica set. Without them the outbox guarantee cannot be shown. |
| D-06 | Transactional outbox (`outboxevents`) | Publish to Redis directly after commit; two-phase commit | Direct publish can lose the event if the process dies between commit and publish. Outbox makes the event part of the same commit. This is the project's headline DBMS concept. |
| D-07 | Redis + BullMQ for jobs | MongoDB-only polling queue; RabbitMQ | BullMQ gives retries, backoff, concurrency and delayed jobs with little code. Redis is only a delivery mechanism; MongoDB stays the source of truth. |
| D-08 | Custom state machine for the pipeline, six states | Embed Twenty CRM / EspoCRM | Our pipeline is tiny. A CRM brings licence obligations (AGPL / mixed) and far more surface than needed. |
| D-09 | Closed-Won is final; Closed-Lost can be reopened to Follow-up with a reason | Allow reopening everything | A won lead already has a client and invoice. Reopening it would need credit notes. Closed-Lost has no side effects, so reopening is safe and audited. |
| D-10 | Optimistic concurrency via explicit `version` field and `expectedVersion` in the request | Pessimistic locks | Edits are rare and conflicts rarer. A version check is simple and gives the client a clear 409. |
| D-11 | Lead identity = website domain > business email domain > phone; free-mail domains never identify a business | Name matching | Names are unreliable ("Acme Pvt Ltd" vs "ACME"). Domain is stable. Records with no identity are flagged `needsReview`. |
| D-12 | Money stored as integer paise; tax as basis points | Decimal128 or floats | Integers are exact and simple. Floats cause rounding errors on invoices. |
| D-13 | One invoice per conversion via idempotency key `conversion:<leadId>` | Check-then-insert in code | Check-then-insert has a race. A unique index cannot be raced. |
| D-14 | PDFKit for invoice PDFs; Invoify only as a design reference | Puppeteer/HTML-to-PDF; adopt Invoify | PDFKit is a small library (MIT) with no browser and no network access, which removes a class of security risks (SSRF via templates). |
| D-15 | Email through a provider adapter interface; uncertain timeouts become `SEND_UNCERTAIN` and are reconciled | Retry on every error | A timeout does not tell us whether the email was sent. Blind retry can double-send an invoice. |
| D-16 | Zod for API bodies and environment | Joi, class-validator | Same schema gives validation and TypeScript types. |
| D-17 | ES modules + strict TypeScript (`noUncheckedIndexedAccess`) | CommonJS, loose TS | Matches current Node/Crawlee tooling; catches undefined-access bugs early. |
| D-18 | Vitest + Supertest; pure logic (state machine, normalisation) tested without a database | Jest | Fast, TS-friendly. Keeping rules pure means they are testable in milliseconds. |
| D-19 | Payment gateway excluded | Add Razorpay/Stripe | Requirements not confirmed (per the plan). |
| D-20 | Licence check is a Phase 5 gate; inventory started now (`07-licence-inventory.md`) | Ignore until release | Plan requires it. Engineering guidance only, not legal advice. |

## Open questions (carried to Phase 2)

1. Which single permitted source will the first adapter target? (Needs the user's source list.)
2. Is there existing scraper code worth reviewing for extraction logic?
3. Invoice content: company details, GST/tax rules, numbering format.
4. Final hosting model if a pilot customer is added (shared hosted vs separate installs).
