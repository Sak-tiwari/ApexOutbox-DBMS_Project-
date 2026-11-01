# Phase 5 findings: what was wrong, what was changed, what is still open

Reviewed: `main` at commit `4ca5d79` (Phase 3 + Phase 4 code). "Verified" means I ran it or a test proves it;
"by reading" means I found it in the code but did not execute it.

## A. Defects found and fixed

| ID | Severity | Finding | Evidence | Fix |
|---|---|---|---|---|
| F-01 | Critical | **Invoice PDF generation never finishes.** `invoice.ts` never pipes the PDF to the file, so the promise never resolves and a 0-byte file is left. Every Phase 4 invoice job would hang. | Verified: ran the original from `main`; no result after 5 s, 0-byte `INV-TEST.pdf`. | Pipe added, atomic temp-file + rename. Regression test opens the PDF and checks `%PDF-` / `%%EOF`. |
| F-02 | Critical | **Phase 3 and Phase 4 were not connected.** Moving a lead to Closed-Won did nothing in Phase 4, and a Lead has no email or amount, which Phase 4 requires. | By reading both code bases. | Closed-Won now requires a `deal` (email, amount, currency, description), stored in the same single-document update as the state change. A hand-off creates client + invoice; a reconciler retries if it fails. End-to-end verified (smoke 17/17). |
| F-03 | Critical | **Anyone could impersonate any lead owner.** The "auth" trusted a client-supplied `x-user-id` header. | By reading; test proves the header is now ignored. | API-key authentication; the user id comes from a server-side key map. |
| F-04 | Critical | **`main` could not be installed or built.** Phase 4 dependencies (`bullmq`, `ioredis`, `pdfkit`, `nodemailer`) missing from `package.json`; Phase 3 files sat in the repo root with imports like `../models/Lead` that resolve outside the repo; the `test` script pointed at a path that did not exist. | Verified for the missing dependencies: `npm install && tsc` on a clean checkout of `main` gave 10 type errors. The broken imports and test path are by reading; the file move fixes them. | Phase 3 files moved to the folders their imports and `package.json` expect; dependencies merged; one remaining type error fixed. |
| F-05 | Critical | **Demo email mode in production** reports success without sending, so invoices would be marked sent and never delivered. | By reading; test added. | App refuses to start in production without SMTP; the email module also refuses. |
| F-06 | High | **Email could be sent twice, and timeouts were not handled** (the plan requires careful handling). A crash after sending, or a retry after a timeout, re-sent the invoice. | By reading; unit tests reproduce the crash window. | Atomic claim to `EMAIL_SENDING` before sending; timeouts become `EMAIL_UNCERTAIN` (never auto-retried); stale `EMAIL_SENDING` also becomes uncertain. Deterministic Message-ID so a provider can be asked. |
| F-07 | High | **Publishing hangs when Redis is down.** With the original queue settings the dispatcher waits forever. | Verified: baseline test, publish still pending after 3 s with Redis stopped. | Fail-fast producer connection, a 5 s publish deadline, exponential backoff (cap 15 min), max 5 attempts then FAILED with an alert log. Verified against a real Redis stopped and restarted. |
| F-08 | High | **The Phase 3 test script always reported success.** `process.exit(0)` ran even after a failed assertion. | Verified: broke a rule on purpose; original exited 0 while printing the failure. | Exits 1 on failure (checked: exit 1 with the rule broken, 0 when restored). |
| F-09 | High | **Errors were classified by message text.** By reading: a Mongoose version error would be a 400, "not found" and "forbidden" were 400, an invalid id caused a cast error, and 500s returned `error.message` to the client. | Tests cover status codes and that internals do not leak. | Typed errors with fixed HTTP codes (400/401/403/404/409/422), generic 500, malformed JSON is 400, oversized body 413. |
| F-10 | High | **Version check and write were separate steps** (read, compare, then `save`). | By reading. | One conditional update on `{id, version, state}`. Sequential staleness verified on a MongoDB-compatible server; the concurrent race test needs real MongoDB (see section D). |
| F-11 | High | **No recovery if Redis loses its data.** Events already marked PUBLISHED would never be processed. | By reading. | Worker sweep re-creates or retries jobs for unsent invoices idle for over 10 minutes. Verified with real Redis (missing job, failed job, live job). |
| F-12 | Medium | Any float accepted as an amount (for example 10.005). | Test. | Max 2 decimal places and an upper bound. |
| F-13 | Medium | nodemailer default timeouts (2 min connect, 10 min socket) would block workers. | By reading. | 10 s / 10 s / 30 s. |
| F-14 | Medium | Concurrent client upsert can raise a duplicate-key error that was not handled. | By reading. | Caught and re-read. 20 concurrent onboardings verified to give 1 client, 1 invoice, 1 event. |
| F-15 | Medium | No readiness probe, structured logs or metrics. | n/a | `/health`, `/ready` (checks Mongo and Redis), JSON logs with secret redaction, `/metrics` with counters and business gauges. |

## B. Decisions the team needs to make (I did not change these)

| ID | Question | Why it matters / recommendation |
|---|---|---|
| D-1 | **Pipeline rules differ from the Phase 1 design.** Phase 3 allows Closed-Won -> Negotiation and Closed-Lost -> New, and has no Negotiation -> Follow-up. The Phase 1 design made Closed-Won final and reopened Closed-Lost to Follow-up. | Phase 3's rules were kept. Re-winning a reopened lead is safe (same invoice, no resend) but silently ignores a changed deal. Recommended: block reopening a Closed-Won lead once its onboarding is DONE. |
| D-2 | **Invoice numbers are `INV-<random id>`, not sequential.** | Many tax regimes require unique consecutive invoice numbers (check with your accountant, especially for GST). Needs a per-tenant counter. |
| D-3 | **No tenant isolation.** The Phase 3/4 models have no `tenantId` (the Phase 1 models did). | Tenant-isolation tests were not written because there is nothing to isolate. If you still plan to host for other businesses, this is the largest remaining gap. |
| D-4 | **Direct onboarding endpoint** (`POST /api/phase4/onboard`) lets any key holder create a client and invoice for any lead id, bypassing the pipeline. | Kept (now authenticated). Recommended: disable it in production. |
| D-5 | **Read access.** Any authenticated user can list and read all leads; only the owner can change one. | Confirm this is intended. |
| D-6 | **Project licence.** The package has no licence field. | Choose one. |

## C. Not done / limits

- **Phase 2 (scraper) does not exist yet**, so the plan's "scraper changes" test could not be written.
- **No rate limiting** on the API (API keys could be guessed at speed). Put a rate-limiting reverse proxy in front, or add middleware.
- **Money is still stored as floating point** in the invoice snapshot (now validated to 2 decimals). Integer paise would be safer.
- **Secrets** come from environment variables only; use your platform's secret store. No key-rotation tooling.
- Alert rules are suggestions in the runbook, not deployed.

## D. What could not be verified here

- **Real MongoDB was not available.** The tests ran against FerretDB 1.24 (a MongoDB-compatible server). With the plain driver and none of our code involved, FerretDB let 2 of 10 concurrent conditional updates succeed, so it is **not atomic under concurrency**, which real MongoDB is. Two tests that prove our locking and claiming (`10 simultaneous transitions...`, `five concurrent processors...`) are therefore skipped on FerretDB and **must be run against real MongoDB** (command in the test report); I have not seen them pass. The same logic is covered by in-memory tests that assume atomic updates.
- **Docker image and compose file were not built or run** (no Docker daemon in my environment).
- **Real SMTP delivery** was not tested (demo mode and an injected transport only).
- **Backup and restore scripts were not run** (no `mongodump` here).
- No load or performance testing.
