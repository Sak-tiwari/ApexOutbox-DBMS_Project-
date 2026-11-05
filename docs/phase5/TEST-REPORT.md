# Phase 5 test report (release candidate `1.0.0-rc.1`)

## Result in my environment

| Check | Result |
|---|---|
| `npm run typecheck` (app + tests) | clean |
| `npm test` (vitest) | **128 passed, 0 failed, 2 skipped** (130 tests, 11 files) |
| `npm run test:legacy` (the Phase 3 team's own script) | 4/4 pass, exit 0 |
| `npm audit` (all dependencies) | 0 vulnerabilities |
| Licence scan, 134 production packages | no GPL/AGPL/LGPL/SSPL; `THIRD_PARTY_NOTICES.md` generated |
| Real-process smoke test (`scripts/smoke.js` against built `dist` API + worker) | **19/19 checks** |
| Browser test of the dashboard (`scripts/ui-check.js`, headless Chromium, real API + worker + Redis, FerretDB) | **24/24 checks**: key gate, XSS probe, buttons and drag-and-drop, illegal move refused, Closed-Won to PDF, reopen with reason, search, mobile width, no console errors |

## Test files

| File | Tests | What it covers |
|---|---|---|
| `tests/unit/email.test.ts` | 17 | which SMTP errors are "uncertain", deterministic Message-ID, no demo mode in production |
| `tests/unit/processor.test.ts` | 14 | send once; replay; 5 concurrent jobs; timeout -> uncertain; retry after definite failure; crash after sending; PDF failure; **bounce -> abandoned; attempt cap; PENDING-with-path repair** |
| `tests/unit/dispatcher.test.ts` | 8 | publish, backoff, hung publish cut off, max attempts, stale recovery, unknown event |
| `tests/unit/transition.test.ts` | 10 | the 4 original Phase 3 cases plus owner (403), not found (404), deal required, concurrent winner, no-op, no dead ends |
| `tests/unit/handoff.test.ts` | 5 | Closed-Won hand-off, reconciler, give-up, invalid deal |
| `tests/unit/requeue.test.ts` | 3 | which invoices are re-queued (now including stale `EMAIL_SENDING`, never abandoned/sent) |
| `tests/unit/invoice-pdf.test.ts` | 3 | PDF finishes and is valid (regression for the hang), path safety |
| `tests/unit/config.test.ts` | 4 | production requires keys and SMTP; weak API keys rejected |
| `tests/http/api.test.ts` | 38 | (adds: create lead, paging, numeric-string version, reopen cancels onboarding, rate limit) |
| (original scope) | |  auth (401, spoofed header ignored), every error code, Closed-Won over HTTP, no leakage in 500s, health/ready/metrics |
| `tests/integration/queue.test.ts` | 7 | **real Redis + BullMQ**: duplicate jobs, outage and recovery, baseline hang, requeue of lost/failed jobs |
| `tests/integration/mongo.test.ts` | 19 (+2 skipped) | **database**: unique constraints, 20 concurrent onboardings, stale-version refusal, full end-to-end with replays, reconciler, crashed dispatcher, uncertain email, HTTP on real data |

## Plan items vs. what was tested

| Plan item | Status |
|---|---|
| Unit, integration and end-to-end tests | Done (above). |
| Database outage | Partly: onboarding failure then reconciler recovery is tested; a live database stop/start was not. |
| Queue (Redis) outage | Done against a real Redis stopped and restarted. |
| Duplicate jobs / duplicate processing | Done (same job twice, 5 concurrent jobs, replayed events, replayed API calls). |
| Invalid transitions | Done. |
| Email timeouts | Done (injected transport; real SMTP not tested). |
| Scraper changes | Done: Phase 2 scraper integrated (see below). Tested with real Crawlee against a local server, on MongoDB, over HTTP and in a real browser. |
| Structured logs, metrics, alerts | Logs and metrics done; alert rules are suggestions in the runbook. |
| Backup / restore test | Scripts written, **not run** (no `mongodump` here). |
| Secrets management / access control | API keys, redaction, production config checks. Per-process rate limiting added (`RATE_LIMIT_PER_MINUTE`); no secret-store integration. |
| Tenant isolation | Not applicable (no tenant concept in Phase 3/4). See finding D-3. |
| Dependency and licence scans | Done. |

## Honest limits

1. **Real MongoDB was not available.** Database tests ran on **FerretDB 1.24** (MongoDB-compatible, SQLite backend).
   FerretDB does not make concurrent conditional updates atomic: using the plain MongoDB driver alone, 2 of 10 concurrent
   `{_id, v:0} -> {$inc v}` updates succeeded. Two tests that prove our locking and claiming are therefore auto-skipped
   on FerretDB:
   - `10 simultaneous transitions with the same version: exactly one wins`
   - `five concurrent processors for one invoice send exactly one email (real claim)`

   **Run these on real MongoDB before release:**
   ```
   docker run -d --name mongo-test -p 27018:27017 mongo:7
   TEST_MONGODB_URI=mongodb://127.0.0.1:27018 npm run test:integration
   ```
   On a real engine all 15 tests in that file run, including the two skipped here. **I have not seen those two pass**: I expect them to, because MongoDB guarantees single-document atomicity, but until they run green on real MongoDB that is an expectation, not a result. If either fails there, it is a real concurrency bug.
2. **Mutation check.** I broke six behaviours on purpose (no atomic claim, no publish deadline, timeout not uncertain, header
   impersonation, PDF not piped, version ignored in the store). All six were caught by tests (one only after I added a
   store-level test for it).
3. The Docker image and compose file were not built or run here.
4. Email "sent" in the smoke test means **demo mode**: no real mail left the machine.

## Not verified for the dashboard launcher

`start-apexoutbox.bat`, `stop-apexoutbox.bat` and `scripts/windows/*.ps1` were written but **not run** (no Windows or PowerShell in my environment). The page, the API and the compiled build were tested on Linux. Test the launcher once on the presentation PC.

## Skips are errors in CI

Without `redis-server`, or without a MongoDB-compatible server, the affected files are skipped with a warning.
`REQUIRE_INTEGRATION=1` turns that into a failure; `REQUIRE_REAL_MONGO=1` also rejects FerretDB so the two atomicity tests
cannot be skipped. `.github/workflows/ci.yml` sets both and runs against `mongo:7`. **That workflow has not run yet**: it
will on the first push; check its result.


## Scraper integration

| Area | Evidence |
|---|---|
| SSRF defence | 36 unit tests: private/loopback/link-local/IPv6/mapped/decimal/hex addresses, DNS that points inside, `localhost.`, ports, credentials, schemes. Redirects to `169.254.169.254` and `localhost` are refused in an integration test. |
| Extraction | mailto links, `[at]`/`&#64;` obfuscation, no gluing of neighbouring elements, image names, cap of 20, 2 MB page limit; a ReDoS found while testing (quadratic regex on a 3 MB page) was fixed. |
| Real crawl | Real Crawlee against a local server: success, no emails, robots.txt refusal, redirect, redirect loop, redirect into an internal address, PDF, 50 MB declared body, 404, 500, closed port. |
| Jobs and leads on MongoDB | enqueue de-duplication, atomic claim, stale-job recovery, one lead per website and contact, per-user separation. The concurrent-claim and concurrent-upsert race tests need real MongoDB (skipped on FerretDB). |
| HTTP | auth, validation, bare domain, per-user cap of 10 waiting scrapes, ownership of job ids. |
| Browser | 32 checks including: scrape a demo page, lead appears with its emails, repeat scrape adds nothing, robots refusal, internal address refused, scraped lead taken to Closed-Won with the scraped email pre-filled, invoice + PDF + email sent. |

Not tested: the public internet (the sandbox only reaches an allow-list), JavaScript-rendered sites (not supported: plain HTML only), DNS rebinding between the safety check and the fetch (a known limit of checking before fetching).
