# ApexOutbox runbook (setup, deployment, recovery)

## 1. What runs
| Process | Command | Role |
|---|---|---|
| API | `node dist/server.js` | REST API: leads, transitions, onboarding, `/health`, `/ready`, `/metrics` |
| Worker | `node dist/worker.js` | invoice PDFs and email, outbox dispatcher, onboarding reconciler, stuck-invoice requeue sweep, website scraper loop |
| MongoDB | | source of truth (no transactions needed, so no replica set is required) |
| Redis | | job delivery only; can be rebuilt from MongoDB |

Run **one** worker process unless you have reviewed the settings: the loops are safe to run twice (all steps are idempotent) but waste work.

## 2. Setup for development
```
npm ci
cp .env.example .env              # set MONGODB_URI, REDIS_URL, API_KEYS
npm run typecheck && npm test
npm run dev          # API       (tsx watch)
npm run dev:worker   # worker
```
Create an API key: `openssl rand -hex 24`, then `API_KEYS=<key>:<userId>`. The `userId` must equal a lead's `ownerId`
for that key to move it. Call the API with `Authorization: Bearer <key>` (or `x-api-key`).

## 3. Configuration
| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI`, `REDIS_URL` | yes | validated at start-up |
| `API_KEYS` | production | `key:user,key2:user2`; keys at least 16 characters |
| `SMTP_HOST/PORT/USER/PASS`, `EMAIL_FROM` | production | without them the app **refuses to start** in production. Outside production it uses DEMO mode (nothing is sent) |
| `CHROMIUM_PATH` | optional | Path to a system Chromium for invoice PDFs. Default: the one `npx playwright-core install chromium` downloads |
| `LEAD_FINDER_MOCK` | optional | `true` = Lead Finder uses sample requests only (demos). Default `false` = live sources |
| `LEAD_FINDER_DISABLED_SOURCES` | optional | Comma list of source ids to switch off, e.g. `reddit` |
| `SCRAPER_ALLOW_LOOPBACK` | optional | `true`/`false`. Lets the scraper read the bundled `/demo/` pages on this machine. Default: on outside production, off in production |
| `INVOICE_DIR` | recommended | persistent volume in production. `docker-compose.yml` forces `/data/invoices` for the worker |
| `RATE_LIMIT_PER_MINUTE` | no | per client IP on `/api`, default 300, `0` disables |
| `NODE_ENV`, `PORT`, `LOG_LEVEL` | no | |

## 4. Deploy (single host)
```
cp .env.example .env     # real secrets; never commit
docker compose up -d --build
curl localhost:3000/ready
```
Put TLS in front (reverse proxy). The app has a per-process rate limit (`RATE_LIMIT_PER_MINUTE`, per client IP); behind several replicas use a gateway limiter for a hard global limit. Use `/ready` for load-balancer checks and
`/health` for liveness. *(The Dockerfile and compose file were not built in my environment; the first build is part of release testing.)*

## 5. Release checklist
```
npm ci
npm run typecheck
npm test                                  # 121 pass; 2 skipped on a non-MongoDB engine
REQUIRE_INTEGRATION=1 REQUIRE_REAL_MONGO=1 TEST_MONGODB_URI=mongodb://127.0.0.1:27018 npx vitest run   # nothing may be skipped
TEST_MONGODB_URI=<real mongod> npm run test:integration   # must show 0 skipped
npm run test:legacy
npm audit
npm run notices                           # regenerate THIRD_PARTY_NOTICES.md; fails on copyleft
npm run build
# start API + worker against a staging stack, then:
API_URL=... API_KEY=... OWNER_ID=<user of that key> MONGODB_URI=... node scripts/smoke.js
```

## 6. Monitoring
`GET /metrics` (requires an API key) exposes:
| Metric | Meaning |
|---|---|
| `apexoutbox_http_requests_total{status}` | request counts by status class |
| `apexoutbox_transitions_total{outcome}` | `OK` or the error code (`VERSION_CONFLICT`, `INVALID_TRANSITION`, ...) |
| `apexoutbox_outbox_pending` / `_failed` | events waiting / permanently failed |
| `apexoutbox_invoices_email_uncertain` / `_abandoned` / `_failed` / `_sending` | needing a human / given up (bounce or too many failures) / failing, will retry / in flight (should be near 0) |
| `apexoutbox_leads_onboarding_pending` / `_failed` | Closed-Won leads not yet onboarded / given up on |

**Suggested alerts** (not deployed): `*_failed > 0`, `*_uncertain > 0` or `*_abandoned > 0` at any time; `outbox_pending` above 20 for 10 minutes;
`/ready` returning 503 for 2 minutes; 5xx rate above 1%. Worker logs contain `ALERT` lines for the same conditions.

## 7. Recovery procedures
All commands use `mongosh <MONGODB_URI>`.

**Outbox events FAILED** (queue was down longer than the retry window):
`db.outboxevents.updateMany({status:"FAILED"},{$set:{status:"PENDING",attempts:0,nextAttemptAt:new Date()}})`

**Invoice EMAIL_UNCERTAIN** (timeout or crash while sending; never auto-retried because it may have been delivered):
1. Find it: `db.invoices.find({status:"EMAIL_UNCERTAIN"},{invoiceNumber:1,"snapshot.email":1,lastError:1})`
2. Ask your email provider whether Message-ID `<INV-...@your-domain>` (the invoice number) was accepted.
3. Delivered: `db.invoices.updateOne({invoiceNumber:"INV-..."},{$set:{status:"EMAIL_SENT"}})`
4. Not delivered: `db.invoices.updateOne({invoiceNumber:"INV-..."},{$set:{status:"EMAIL_FAILED"}})`. The sweep re-sends it within about 10 minutes.

**Invoice EMAIL_ABANDONED** (the provider rejected the address with a 5xx such as 550, or 5 sends failed): the system stops on purpose.
Read `lastError`, correct the address in `snapshot.email` (or fix the provider problem), then
`db.invoices.updateOne({invoiceNumber:"INV-..."},{$set:{status:"EMAIL_FAILED",emailAttempts:0}})`; the sweep re-sends it within about 10 minutes.

**Lead onboarding CANCELLED:** the lead was re-opened from Closed-Won before its client/invoice was created, so nothing is billed.
If it is won again, onboarding starts again with the new deal.

**Lead onboarding FAILED** (bad deal data or repeated errors): read `onboardingError` on the lead, fix `deal`, then
`db.leads.updateOne({_id:ObjectId("...")},{$set:{onboardingStatus:"PENDING",onboardingAttempts:0}})`.

**Redis lost its data:** nothing to do. Within about 10 minutes the worker recreates jobs for unsent invoices
(`requeue` sweep). The email step is safe to repeat (at most one send per invoice).

**Worker killed mid-send:** the invoice stays `EMAIL_SENDING`; the sweep picks it up after 10 idle minutes and it is marked `EMAIL_UNCERTAIN` (see above).

**Container health:** the API is checked via `/health`; the worker touches `/tmp/worker-heartbeat` every 15 s while connected to MongoDB and the container turns unhealthy if it stops.

**MongoDB down:** `/ready` returns 503, requests fail with 500. No manual step after it returns; the reconciler and sweeps catch up.

**Restore from backup** (stop api and worker first):
```
MONGODB_URI=... BACKUP_DIR=/backups ./scripts/backup.sh              # take a backup (schedule daily)
MONGODB_URI=... ./scripts/restore.sh backups/mongo-<stamp>.archive.gz backups/invoices-<stamp>.tar.gz
```
Then start the worker: in-flight onboarding and invoices are finished by the reconciler and sweep.
*(These scripts were not run in my environment: test a restore on a staging copy before relying on them.)*

## 8. Security notes
- Keys live only in environment variables; rotate by changing `API_KEYS` and restarting. Logs redact authorization headers and SMTP passwords.
- Anyone with a key can read all leads; only the lead owner can move one (decision D-5).
- Consider disabling `POST /api/phase4/onboard` in production (decision D-4).


## Scraper operations

- Jobs are in the `scrapejobs` collection: `QUEUED -> RUNNING -> DONE | FAILED`. The worker takes one job at a time. A job left `RUNNING` by a crashed worker is re-queued after 5 minutes (once), then failed with `WORKER_LOST`.
- `/metrics` shows `apexoutbox_scrape_jobs_queued` and `apexoutbox_scrape_jobs_failed`. A growing queued count with a healthy API means the worker is not running.
- Common `errorCode`s on a failed job: `ROBOTS` (site forbids robots), `UNSAFE_URL` (private address or unsafe redirect), `HTTP_ERROR`, `NOT_HTML`, `TOO_MANY_REDIRECTS`, `FAILED` (could not load).
- Each user may have 10 waiting scrapes. Repeating a scrape of a site never creates a second lead.


## Lead Finder operations

- Searches live in `leadsearches`: `QUEUED -> RUNNING -> DONE | FAILED`. A search left RUNNING by a crashed worker is failed after 10 minutes.
- Saved searches with a schedule are put back in the queue by the worker (checked every minute).
- A source chip "blocked" means the site answered 401/403/429 (common for Reddit from some networks). Nothing is retried; use another source or demo mode.
- Each user may have 5 searches waiting at a time.


## Invoice template operations

- Invoice PDFs render in Chromium (API for previews, worker for real invoices). If Chromium is missing or broken the worker logs
  `built-in HTML template failed too (is Chromium installed?)` and uses the basic PDF; nothing is lost. Fix with `npx playwright-core install chromium`.
- `invoice template failed; using the built-in template` in the worker log names the invoice and template version that failed.
  The customer still got an invoice. Open the template in the editor: the problems are listed.
- Template files (logos, fonts, original .docx) are stored under `INVOICE_DIR/assets/<hash of owner>/`. Back this folder up with the invoices.
- A user cannot reuse a printed invoice number; the deal form answers 409 with a clear message.
