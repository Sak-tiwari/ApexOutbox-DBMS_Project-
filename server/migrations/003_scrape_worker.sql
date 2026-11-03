-- 003: background scraper worker support.
--
-- The worker has no tenant until it has claimed a job, so claiming is the one cross-tenant operation:
-- a SECURITY DEFINER function that locks a single job (FOR UPDATE SKIP LOCKED, so several workers never
-- take the same one) and returns only its ids. Everything after that runs inside withTenant().
-- A RUNNING job whose lock has not been refreshed for p_stale_seconds belonged to a crashed worker and
-- is taken over; processing is idempotent (leads dedupe on a unique index), so a re-run is harmless.

CREATE FUNCTION scrape_claim_next(p_worker text, p_stale_seconds integer)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE scrape_jobs j
     SET status = 'RUNNING', locked_at = now(), locked_by = p_worker, started_at = coalesce(j.started_at, now())
   WHERE j.id = (
           SELECT s.id FROM scrape_jobs s
             JOIN tenants t ON t.id = s.tenant_id AND t.status = 'ACTIVE' AND t.deleted_at IS NULL
            WHERE s.status = 'QUEUED'
               OR (s.status = 'RUNNING' AND s.locked_at < now() - make_interval(secs => p_stale_seconds))
            ORDER BY s.created_at
            FOR UPDATE OF s SKIP LOCKED
            LIMIT 1)
  RETURNING j.id, j.tenant_id
$$;

REVOKE ALL ON FUNCTION scrape_claim_next(text, integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apex_app') THEN
    GRANT EXECUTE ON FUNCTION scrape_claim_next(text, integer) TO apex_app;
  END IF;
END $$;
