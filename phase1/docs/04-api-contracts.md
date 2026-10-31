# 04 - API contracts

Base path `/api`. JSON only. All business routes are tenant-scoped on the server (tenant comes from the
authenticated user, never from the request body). Authentication arrives in Phase 3; until then the single
internal tenant is used.

## Conventions

**Error shape (all errors):**
```json
{ "error": { "code": "VERSION_CONFLICT", "message": "Lead was changed by someone else.", "details": {} } }
```

| HTTP | code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Zod validation failed (`details` lists fields) |
| 401 | `UNAUTHENTICATED` | Missing/invalid credentials (Phase 3) |
| 403 | `FORBIDDEN` | Role not allowed (Phase 3) |
| 404 | `NOT_FOUND` | Missing, or belongs to another tenant (never reveal which) |
| 409 | `VERSION_CONFLICT` | `expectedVersion` does not match |
| 422 | `INVALID_TRANSITION` | State machine rejected the move (`details.allowed` lists legal targets) |
| 422 | `REASON_REQUIRED` | Reopen without a reason |
| 503 | `DEPENDENCY_DOWN` | Redis/MongoDB unavailable |

**Pagination:** `?limit=` (1-100, default 25) and `?cursor=` (opaque). Response: `{ "items": [], "nextCursor": null }`.
**Idempotency:** `POST /scrape-jobs` accepts an optional `Idempotency-Key` header; the same key returns the original job.

## Already implemented in Phase 1

| Method | Path | Response |
|---|---|---|
| GET | `/health` | `200 { "status": "ok" }` (liveness) |
| GET | `/ready` | `200` or `503 { "status", "checks": { "mongo", "redis" } }` (readiness) |

## Scrape jobs (Phase 2)

**POST `/api/scrape-jobs`**
```json
{ "adapter": "example-directory", "params": { "query": "salons", "city": "Ghaziabad", "maxPages": 5 } }
```
`202 { "id": "...", "status": "QUEUED" }`. `adapter` must be registered; `params` validated by that adapter's Zod schema.

**GET `/api/scrape-jobs/:id`**
```json
{ "id": "...", "adapter": "...", "status": "RUNNING",
  "counts": { "found": 40, "inserted": 31, "duplicates": 7, "rejected": 2 },
  "errors": [], "startedAt": "...", "finishedAt": null }
```

## Leads (Phase 3)

**GET `/api/leads`** query: `status`, `ownerId`, `followUpBefore`, `q` (name/company text), `needsReview`, `limit`, `cursor`.

**GET `/api/leads/:id`** returns the lead plus `activities` (newest first) and `allowedTransitions`.

**POST `/api/leads/:id/transitions`**
```json
{ "to": "NEGOTIATION", "expectedVersion": 3, "reason": "optional except for reopen" }
```
Success `200` returns the updated lead (`version` incremented). When `to` is `CLOSED_WON` the response also contains
`clientId`. Errors: 409 `VERSION_CONFLICT`, 422 `INVALID_TRANSITION` / `REASON_REQUIRED`.

## Clients and invoices (Phase 4)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/clients` | list, newest first |
| GET | `/api/clients/:id` | client with invoice summaries |
| GET | `/api/invoices/:id` | invoice status, totals, `pdf` metadata, email delivery state |
| GET | `/api/invoices/:id/pdf` | streams the stored PDF; tenant check on every download |

## Zod schemas (to be implemented as contracts)

```ts
TransitionBody = z.object({
  to: z.enum(LEAD_STATUSES),
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().min(5).max(1000).optional(),
});
ScrapeJobBody = z.object({ adapter: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}) });
```
