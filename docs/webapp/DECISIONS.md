# Web app: decisions and deviations from earlier phases

| ID | Decision | Replaces / differs from | Why |
|---|---|---|---|
| W-01 | PostgreSQL 16 | Phase 1 D-03 (MongoDB) | Requested for the web app. Relational integrity (composite FKs, CHECKs, real transactions) replaces Mongo's "unique index + discipline". |
| W-02 | `tenant_id` on every table plus RLS | Phase 5 finding D-3 (no tenant isolation) | Required for multi-tenant hosting. Restores the Phase 1 design. |
| W-03 | No Redis/BullMQ: Postgres outbox with `SKIP LOCKED`, `LISTEN/NOTIFY` for real time | Phase 4/5 BullMQ | The outbox row is written in the same transaction as the business change, so "committed but never queued" cannot happen, and there is one less service to run. |
| W-04 | CLOSED_WON is final; CLOSED_LOST reopens to FOLLOW_UP with a reason | Phase 3/5 rules (Closed-Won -> Negotiation) | Re-winning a lead would bill twice. Enforced by trigger as well as code. |
| W-05 | Integer paise + gapless sequential invoice numbers | Phase 5 floats, `INV-<random>` | Phase 5 findings D-2 and section C. |
| W-06 | One account per e-mail address platform-wide | n/a | Login does not ask for a tenant. A person in two businesses needs two e-mail addresses. |
| W-07 | Mongo-era code kept under `legacy/mongo/` | n/a | Reference only (e.g. the Phase 4 e-mail "uncertain" logic being ported); not built or tested. |
| W-08 | Scraper runs in-process as a Postgres-queue worker; jobs are claimed by a `SECURITY DEFINER` function (`scrape_claim_next`) | Phase 2 one-shot CLI with Crawlee | The queue lives in the same database as the leads, so progress, cancel and tenant isolation need no extra service. Crawlee/Playwright were dropped: the generic adapter only needs static HTML, and a plain pinned-socket fetcher is much easier to make SSRF-safe. |
| W-09 | SSRF defence in depth: per-workspace domain allowlist, no IP literals/internal names/odd ports, resolve once + all answers public + socket pinned to that answer, every redirect hop re-vetted | Phase 2 `isSafeUrl` (checked once, then fetched by a library that resolves again) | The old check was open to DNS rebinding and redirects to internal hosts. |
| W-10 | robots.txt: longest-match with Allow winning ties, `Crawl-delay` honoured up to 10 s, 4xx = allowed, 5xx/timeout = do not crawl | n/a | RFC 9309 behaviour, erring on the side of not crawling. |
| W-11 | One scraped lead per business domain (`domain:<host>` dedupe key); a 2nd page of the same site counts as a duplicate | Phase 2 `website|email` key (one lead per address) | Matches the Phase 1 identity rules and the unique index. |
| W-12 | Members change only leads they own or that nobody owns; admins/owners change any. Reads are workspace-wide | Phase 3 "only the owner may transition" | Multi-user workspaces need an admin override, and unowned scraped leads must be workable. |
| W-13 | CSV import refuses cells starting with `= + - @ TAB CR` (phone cells are validated by pattern instead) | n/a | Stops formula injection at the door. Exports (stage 6) will additionally neutralise cells. |
