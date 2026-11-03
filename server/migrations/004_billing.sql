-- 004: invoices become immutable once issued; e-mail outbox worker support.

-- ---------------------------------------------------------------------------------------------
-- Issued invoices are legal documents: number, amounts, currency, client and the render snapshot can
-- never change. Only status (along the legal path), payment/pdf bookkeeping and soft delete may.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION invoices_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    IF NEW.number IS DISTINCT FROM OLD.number
       OR NEW.subtotal_minor <> OLD.subtotal_minor
       OR NEW.tax_minor <> OLD.tax_minor
       OR NEW.total_minor <> OLD.total_minor
       OR NEW.currency <> OLD.currency
       OR NEW.client_id <> OLD.client_id
       OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
       OR NEW.idempotency_key <> OLD.idempotency_key
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
      RAISE EXCEPTION 'issued invoice % is immutable', OLD.id USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF OLD.status IN ('PAID', 'VOID') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'invoice % is % and cannot change status', OLD.id, OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'SENT' AND NEW.status = 'ISSUED' THEN
    RAISE EXCEPTION 'invoice % cannot go back to ISSUED', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_guard BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_guard();

-- Line items are written once, together with the invoice.
CREATE TRIGGER invoice_items_append_only BEFORE UPDATE OR DELETE ON invoice_items FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------------------------
-- E-mail outbox worker.
--   email_claim_next:   locks ONE due PENDING row (SKIP LOCKED), marks it SENDING, counts the attempt.
--   email_expire_stale: a row stuck in SENDING means a worker died around the SMTP call. The mail may
--                       or may not have gone out, so it becomes UNCERTAIN (a human decides). It is
--                       NEVER re-sent automatically: that could deliver an invoice twice.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION email_claim_next(p_worker text)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE email_outbox e
     SET status = 'SENDING', locked_at = now(), locked_by = p_worker, attempts = e.attempts + 1
   WHERE e.id = (
           SELECT o.id FROM email_outbox o
             JOIN tenants t ON t.id = o.tenant_id AND t.status = 'ACTIVE' AND t.deleted_at IS NULL
            WHERE o.status = 'PENDING' AND o.next_attempt_at <= now()
            ORDER BY o.next_attempt_at, o.created_at
            FOR UPDATE OF o SKIP LOCKED
            LIMIT 1)
  RETURNING e.id, e.tenant_id
$$;

CREATE FUNCTION email_expire_stale(p_stale_seconds integer)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH moved AS (
    UPDATE email_outbox
       SET status = 'UNCERTAIN', last_error = 'Sending was interrupted; delivery status unknown. Check with the provider before retrying.'
     WHERE status = 'SENDING' AND locked_at < now() - make_interval(secs => p_stale_seconds)
    RETURNING 1)
  SELECT count(*)::int FROM moved
$$;

REVOKE ALL ON FUNCTION email_claim_next(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION email_expire_stale(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apex_app') THEN
    GRANT EXECUTE ON FUNCTION email_claim_next(text) TO apex_app;
    GRANT EXECUTE ON FUNCTION email_expire_stale(integer) TO apex_app;
  END IF;
END $$;
