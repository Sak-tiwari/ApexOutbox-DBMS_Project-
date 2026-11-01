# Phase 5 test report (release candidate `1.0.0-rc.1`)

## Result in my environment

| Check | Result |
|---|---|
| `npm run typecheck` (app + tests) | clean |
| `npm test` (vitest) | **102 passed, 0 failed, 2 skipped** (104 tests, 11 files) |
| `npm run test:legacy` (the Phase 3 team's own script) | 4/4 pass, exit 0 |
| `npm audit` (all dependencies) | 0 vulnerabilities |
| Licence scan, 134 production packages | no GPL/AGPL/LGPL/SSPL; `THIRD_PARTY_NOTICES.md` generated |
| Real-process smoke test (`scripts/smoke.js` against built `dist` API + worker) | **17/17 checks** |

## Test files

| File | Tests | What it covers |
|---|---|---|
| `tests/unit/email.test.ts` | 17 | which SMTP errors are "uncertain", deterministic Message-ID, no demo mode in production |
| `tests/unit/processor.test.ts` | 10 | send once; replay; 5 concurrent jobs; timeout -> uncertain; retry after definite failure; crash after sending; PDF failure |
| `tests/unit/dispatcher.test.ts` | 8 | publish, backoff, hung publish cut off, max attempts, stale recovery, unknown event |
| `tests/unit/transition.test.ts` | 10 | the 4 original Phase 3 cases plus owner (403), not found (404), deal required, concurrent winner, no-op, no dead ends |
| `tests/unit/handoff.test.ts` | 5 | Closed-Won hand-off, reconciler, give-up, invalid deal |
| `tests/unit/requeue.test.ts` | 3 | which invoices are re-queued |
| `tests/unit/invoice-pdf.test.ts` | 3 | PDF finishes and is valid (regression for the hang), path safety |
| `tests/unit/config.test.ts` | 4 | production requires keys and SMTP; weak API keys rejected |
| `tests/http/api.test.ts` | 23 | auth (401, spoofed header ignored), every error code, Closed-Won over HTTP, no leakage in 500s, health/ready/metrics |
| `tests/integration/queue.test.ts` | 6 | **real Redis + BullMQ**: duplicate jobs, outage and recovery, baseline hang, requeue of lost/failed jobs |
| `tests/integration/mongo.test.ts` | 13 (+2 skipped) | **database**: unique constraints, 20 concurrent onboardings, stale-version refusal, full end-to-end with replays, reconciler, crashed dispatcher, uncertain email, HTTP on real data |

## Plan items vs. what was tested

| Plan item | Status |
|---|---|
| Unit, integration and end-to-end tests | Done (above). |
| Database outage | Partly: onboarding failure then reconciler recovery is tested; a live database stop/start was not. |
| Queue (Redis) outage | Done against a real Redis stopped and restarted. |
| Duplicate jobs / duplicate processing | Done (same job twice, 5 concurrent jobs, replayed events, replayed API calls). |
| Invalid transitions | Done. |
| Email timeouts | Done (injected transport; real SMTP not tested). |
| Scraper changes | Not possible: Phase 2 does not exist yet. |
| Structured logs, metrics, alerts | Logs and metrics done; alert rules are suggestions in the runbook. |
| Backup / restore test | Scripts written, **not run** (no `mongodump` here). |
| Secrets management / access control | API keys, redaction, production config checks. No rate limiting; no secret-store integration. |
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
