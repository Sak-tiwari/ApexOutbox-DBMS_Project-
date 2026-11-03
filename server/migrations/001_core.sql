-- ApexOutbox 001: core multi-tenant schema (PostgreSQL 16).
--
-- Design rules (see docs/webapp/SCHEMA.md):
--  * Every business table has tenant_id NOT NULL.
--  * Every cross-table reference is a COMPOSITE foreign key (tenant_id, x_id) -> parent(tenant_id, id),
--    so a row can never point at another tenant's row, even if application code is wrong.
--  * Row-Level Security (RLS) is a second wall: the app role only sees rows where
--    tenant_id = current_setting('app.tenant_id'). Application queries ALSO filter by tenant_id.
--  * Money is integer minor units (paise); tax is basis points.
--  * Soft deletes (deleted_at) on user-facing entities; audit_log and activities are append-only.
--  * Uniqueness (one client per lead, one invoice per idempotency key, ...) is enforced by the database.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

-- Emits a small NOTIFY (delivered only if the transaction commits) that the API turns into
-- Server-Sent Events. Payload carries ids only, never row data.
CREATE FUNCTION notify_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'apex_changes',
    json_build_object('t', NEW.tenant_id, 'e', TG_ARGV[0], 'id', NEW.id, 'op', TG_OP)::text
  );
  RETURN NEW;
END $$;

CREATE FUNCTION forbid_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------------------------------------
-- tenants and users
-- ---------------------------------------------------------------------------------------------

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  -- Tenant settings drive role-aware UI and behaviour, e.g.
  -- {"features":{"scraper":true,"invoices":true},"invoice":{"prefix":"INV","defaultTaxRateBp":1800,"currency":"INR"}}
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX tenants_slug_uq ON tenants (slug) WHERE deleted_at IS NULL;
CREATE TRIGGER tenants_updated BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  email          text NOT NULL CHECK (email = lower(email) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (tenant_id, id)
);
-- One account per e-mail address across the whole platform (login does not ask for a tenant).
CREATE UNIQUE INDEX users_email_uq ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX users_tenant_idx ON users (tenant_id, role) WHERE deleted_at IS NULL;
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- scraping
-- ---------------------------------------------------------------------------------------------

-- SSRF-safe allowlist: a tenant can only scrape hosts that a tenant Admin has explicitly allowed.
CREATE TABLE scrape_allowed_domains (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  domain      text NOT NULL CHECK (domain = lower(domain) AND domain ~ '^([a-z0-9-]+\.)+[a-z]{2,}$'),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, domain),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

CREATE TABLE scrape_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  created_by       uuid,
  adapter          text NOT NULL CHECK (length(adapter) BETWEEN 1 AND 100),
  params           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
  status           text NOT NULL DEFAULT 'QUEUED'
                     CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  cancel_requested boolean NOT NULL DEFAULT false,
  pages_total      integer NOT NULL DEFAULT 0 CHECK (pages_total >= 0),
  pages_done       integer NOT NULL DEFAULT 0 CHECK (pages_done >= 0),
  found            integer NOT NULL DEFAULT 0 CHECK (found >= 0),
  inserted         integer NOT NULL DEFAULT 0 CHECK (inserted >= 0),
  duplicates       integer NOT NULL DEFAULT 0 CHECK (duplicates >= 0),
  rejected         integer NOT NULL DEFAULT 0 CHECK (rejected >= 0),
  errors           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors) = 'array'),
  idempotency_key  text,
  locked_at        timestamptz,
  locked_by        text,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE UNIQUE INDEX scrape_jobs_idem_uq ON scrape_jobs (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX scrape_jobs_list_idx ON scrape_jobs (tenant_id, created_at DESC, id DESC);
-- Worker polling: oldest QUEUED job first.
CREATE INDEX scrape_jobs_queue_idx ON scrape_jobs (created_at) WHERE status = 'QUEUED';
CREATE TRIGGER scrape_jobs_updated BEFORE UPDATE ON scrape_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- leads, clients, activities
-- ---------------------------------------------------------------------------------------------

CREATE TABLE leads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  company_name   text CHECK (length(company_name) <= 200),
  email          text CHECK (email = lower(email)),
  phone          text CHECK (length(phone) <= 40),
  website        text CHECK (length(website) <= 500),
  dedupe_key     text,
  needs_review   boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'NEW'
                   CHECK (status IN ('NEW', 'CONTACTED', 'FOLLOW_UP', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST')),
  -- Optimistic concurrency: every transition must present the version it read.
  version        integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  owner_id       uuid,
  follow_up_at   timestamptz,
  source_adapter text NOT NULL DEFAULT 'manual',
  source_url     text,
  scraped_at     timestamptz,
  scrape_job_id  uuid,
  client_id      uuid,
  search_text    text GENERATED ALWAYS AS (
                   lower(coalesce(name, '') || ' ' || coalesce(company_name, '') || ' ' ||
                         coalesce(email, '') || ' ' || coalesce(website, ''))
                 ) STORED,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id)      REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, scrape_job_id) REFERENCES scrape_jobs (tenant_id, id),
  -- A won lead has always been converted into a client.
  CONSTRAINT leads_won_has_client CHECK (status <> 'CLOSED_WON' OR client_id IS NOT NULL)
);
-- Database-level duplicate protection for scraped leads. Leads without a reliable identity
-- (dedupe_key NULL) are flagged needs_review and never collide.
CREATE UNIQUE INDEX leads_dedupe_uq ON leads (tenant_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX leads_board_idx   ON leads (tenant_id, status, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX leads_list_idx    ON leads (tenant_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX leads_owner_idx   ON leads (tenant_id, owner_id, status) WHERE deleted_at IS NULL;
CREATE INDEX leads_followup_idx ON leads (tenant_id, follow_up_at) WHERE follow_up_at IS NOT NULL AND deleted_at IS NULL;
-- Live search (ILIKE '%term%') stays fast with a trigram index.
CREATE INDEX leads_search_trgm ON leads USING gin (search_text gin_trgm_ops);
CREATE TRIGGER leads_updated BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A won lead is final: it already has a client and an invoice (credit notes are out of scope).
CREATE FUNCTION leads_won_is_final() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'CLOSED_WON' AND NEW.status <> 'CLOSED_WON' THEN
    RAISE EXCEPTION 'A CLOSED_WON lead cannot change status' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leads_won_final BEFORE UPDATE OF status ON leads FOR EACH ROW EXECUTE FUNCTION leads_won_is_final();

CREATE TABLE clients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  lead_id          uuid NOT NULL,
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  company_name     text CHECK (length(company_name) <= 200),
  email            text NOT NULL CHECK (email = lower(email)),
  phone            text CHECK (length(phone) <= 40),
  billing_address  jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(billing_address) = 'object'),
  tax_id           text CHECK (length(tax_id) <= 40),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (tenant_id, id),
  -- At most one client per lead. A retry of the conversion hits this and becomes harmless.
  UNIQUE (tenant_id, lead_id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id)
);
CREATE INDEX clients_list_idx ON clients (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER clients_updated BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE leads
  ADD CONSTRAINT leads_client_fk FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id);

-- Append-only audit trail of everything that happens to a lead (the pipeline history).
CREATE TABLE activities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  lead_id      uuid NOT NULL,
  type         text NOT NULL CHECK (type IN ('CREATED', 'STATUS_CHANGED', 'NOTE', 'OWNER_CHANGED', 'CONVERTED', 'IMPORTED')),
  from_status  text,
  to_status    text,
  reason       text CHECK (length(reason) <= 1000),
  actor_id     uuid,
  actor_type   text NOT NULL DEFAULT 'USER' CHECK (actor_type IN ('USER', 'SYSTEM')),
  at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lead_id)  REFERENCES leads (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX activities_lead_idx ON activities (tenant_id, lead_id, at DESC);
CREATE TRIGGER activities_append_only BEFORE UPDATE OR DELETE ON activities FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------------------------
-- invoices
-- ---------------------------------------------------------------------------------------------

-- Gapless per-tenant invoice numbering: the counter row is locked and bumped inside the same
-- transaction that issues the invoice, so a rolled-back issue does not burn a number.
CREATE TABLE invoice_counters (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants (id),
  last_number  integer NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);

CREATE TABLE invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  client_id        uuid NOT NULL,
  lead_id          uuid,
  -- e.g. "conversion:<leadId>". One intended invoice per billing event.
  idempotency_key  text NOT NULL,
  number           text,
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ISSUED', 'SENT', 'PAID', 'VOID')),
  currency         char(3) NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor   bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor        bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor      bigint NOT NULL CHECK (total_minor >= 0),
  -- Immutable render input for the PDF: later edits to the client never change an issued invoice.
  snapshot         jsonb NOT NULL DEFAULT '{}'::jsonb,
  pdf_storage_key  text,
  pdf_sha256       text CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  pdf_generated_at timestamptz,
  issued_at        timestamptz,
  due_at           timestamptz,
  paid_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id)   REFERENCES leads (tenant_id, id),
  CONSTRAINT invoices_total_ok CHECK (total_minor = subtotal_minor + tax_minor),
  CONSTRAINT invoices_number_when_issued CHECK (status = 'DRAFT' OR number IS NOT NULL)
);
CREATE UNIQUE INDEX invoices_number_uq ON invoices (tenant_id, number) WHERE number IS NOT NULL;
CREATE INDEX invoices_list_idx ON invoices (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX invoices_client_idx ON invoices (tenant_id, client_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX invoices_status_idx ON invoices (tenant_id, status) WHERE deleted_at IS NULL;
CREATE TRIGGER invoices_updated BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  invoice_id         uuid NOT NULL,
  position           integer NOT NULL CHECK (position >= 0),
  description        text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  quantity           numeric(12, 3) NOT NULL CHECK (quantity > 0),
  unit_amount_minor  bigint NOT NULL CHECK (unit_amount_minor >= 0),
  tax_rate_bp        integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  UNIQUE (tenant_id, invoice_id, position),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- e-mail outbox (transactional: the row is written in the same transaction as the business change)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE email_outbox (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  -- Same business fact => same key => only one row => at most one e-mail.
  idempotency_key      text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('INVOICE', 'GENERIC')),
  invoice_id           uuid,
  to_email             text NOT NULL CHECK (to_email = lower(to_email)),
  subject              text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  body_text            text NOT NULL,
  status               text NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'UNCERTAIN', 'FAILED', 'ABANDONED')),
  attempts             integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts         integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  locked_at            timestamptz,
  locked_by            text,
  provider_message_id  text,
  last_error           text,
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  CONSTRAINT email_invoice_kind CHECK (kind <> 'INVOICE' OR invoice_id IS NOT NULL)
);
-- Dispatcher polling: due PENDING rows, oldest first (FOR UPDATE SKIP LOCKED).
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at, created_at) WHERE status = 'PENDING';
CREATE INDEX email_outbox_stuck_idx ON email_outbox (locked_at) WHERE status = 'SENDING';
CREATE INDEX email_outbox_list_idx ON email_outbox (tenant_id, created_at DESC, id DESC);
CREATE TRIGGER email_outbox_updated BEFORE UPDATE ON email_outbox FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- audit log (security-relevant actions; append-only)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  actor_id     uuid,
  action       text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  entity_type  text,
  entity_id    text,
  -- Never put secrets, passwords, tokens or full e-mail bodies here.
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_idx ON audit_log (tenant_id, at DESC, id DESC);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------------------------
-- real-time change notifications (consumed by the API's SSE layer)
-- ---------------------------------------------------------------------------------------------

CREATE TRIGGER leads_notify        AFTER INSERT OR UPDATE ON leads        FOR EACH ROW EXECUTE FUNCTION notify_change('lead');
CREATE TRIGGER clients_notify      AFTER INSERT OR UPDATE ON clients      FOR EACH ROW EXECUTE FUNCTION notify_change('client');
CREATE TRIGGER invoices_notify     AFTER INSERT OR UPDATE ON invoices     FOR EACH ROW EXECUTE FUNCTION notify_change('invoice');
CREATE TRIGGER email_outbox_notify AFTER INSERT OR UPDATE ON email_outbox FOR EACH ROW EXECUTE FUNCTION notify_change('email');
CREATE TRIGGER scrape_jobs_notify  AFTER INSERT OR UPDATE ON scrape_jobs  FOR EACH ROW EXECUTE FUNCTION notify_change('scrape_job');

-- ---------------------------------------------------------------------------------------------
-- Row-Level Security: the second tenant wall.
-- The app connects as a non-owner role without BYPASSRLS, so these policies always apply to it.
-- ---------------------------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'scrape_allowed_domains', 'scrape_jobs', 'leads', 'clients', 'activities',
    'invoice_counters', 'invoices', 'invoice_items', 'email_outbox', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
      t);
  END LOOP;
END $$;

-- tenants is keyed by id rather than tenant_id.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());

-- ---------------------------------------------------------------------------------------------
-- Privileges for the application role (created by scripts/db-setup.sh).
-- ---------------------------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apex_app') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO apex_app', current_database());
    GRANT USAGE ON SCHEMA public TO apex_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO apex_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO apex_app;
    -- Append-only tables: the app can read and insert, never change history.
    REVOKE UPDATE, DELETE ON activities, audit_log FROM apex_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO apex_app;
  END IF;
END $$;
