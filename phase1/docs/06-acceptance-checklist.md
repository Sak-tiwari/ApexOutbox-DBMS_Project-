# 06 - Phase 1 acceptance checklist

Status as of this delivery. `[x]` = done and verified, `[ ]` = needs your action or later phase.

## Decisions and design
- [x] Business scope, internal-first, tenant approach (`01-architecture.md`, D-01, D-04)
- [x] Schema fields, normalisation, indexes, deduplication rules (`02-schema-spec.md`, `src/domain/normalize.ts`)
- [x] Pipeline transitions and Closed-Won rules (`05-...md`, `src/domain/pipeline.ts`)
- [x] API contracts, outbox event shape, idempotency strategy (`04-...md`, `05-...md`)
- [x] Failure and recovery design (`01-architecture.md` section 4)
- [x] Decision log with alternatives and reasons (`03-decision-log.md`)
- [x] Licence inventory started (`07-licence-inventory.md`)

## Repository
- [x] TypeScript project (strict mode), ES modules
- [x] Environment validation with Zod, fails fast with readable errors
- [x] Seven Mongoose models with validation and the planned indexes
- [x] Health (`/health`) and readiness (`/ready`) endpoints
- [x] Separate API and worker entry points
- [x] `docker-compose.yml` for MongoDB (replica set) and Redis
- [x] `npm run typecheck` passes
- [x] `npm test` passes: 4 files, 20 tests (state machine, normalisation, env, health)

## Needs your machine (could not be verified here)
- [ ] `docker compose up -d` starts MongoDB replica set and Redis
- [ ] `npm run dev:api` connects and `GET /ready` returns `{"status":"ready"}`
- [ ] `npm run dev:worker` connects without errors
- [ ] Confirm indexes were created (`db.leads.getIndexes()` in mongosh)

## Sign-off questions (needed before Phase 2)
- [ ] First permitted scraping source (and its terms/robots rules)
- [ ] Existing scraper code to review, if any
- [ ] Invoice requirements: company details, tax, numbering
- [ ] Hosting model if a pilot customer is added

## Carried forward (not Phase 1)
- Transition service with transactions and its integration tests (Phase 3)
- Authentication and roles (Phase 3)
- Crawlee adapter, ingestion service (Phase 2)
- Outbox dispatcher, PDF, email (Phase 4)
