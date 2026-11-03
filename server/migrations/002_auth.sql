-- ApexOutbox 002: authentication (lockout, TOTP 2FA, rotating refresh tokens).

ALTER TABLE users
  ADD COLUMN must_change_password  boolean     NOT NULL DEFAULT false,
  ADD COLUMN password_changed_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN failed_login_count    integer     NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  ADD COLUMN locked_until          timestamptz,
  ADD COLUMN last_login_at         timestamptz,
  -- TOTP secrets are stored ENCRYPTED (AES-256-GCM, key from the environment), never in clear text.
  ADD COLUMN totp_enabled          boolean     NOT NULL DEFAULT false,
  ADD COLUMN totp_secret_enc       text,
  ADD COLUMN totp_pending_enc      text,
  -- Last accepted 30-second time step: a code can never be used twice (replay protection).
  ADD COLUMN totp_last_step        bigint,
  ADD CONSTRAINT users_totp_has_secret CHECK (NOT totp_enabled OR totp_secret_enc IS NOT NULL);

-- One row per issued refresh token. Tokens are random, only a SHA-256 hash is stored, and each one
-- is single-use: refreshing marks it used and issues the next token in the same "family".
-- Presenting an already-used token means it was stolen or replayed, so the whole family is revoked.
CREATE TABLE refresh_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  user_id            uuid NOT NULL,
  family_id          uuid NOT NULL,
  token_hash         text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  -- Absolute lifetime of the whole session chain, however often it is refreshed.
  family_expires_at  timestamptz NOT NULL,
  used_at            timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,
  replaced_by        uuid,
  ip                 text,
  user_agent         text CHECK (length(user_agent) <= 300),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE UNIQUE INDEX refresh_tokens_hash_uq ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (tenant_id, user_id) WHERE revoked_at IS NULL;

-- Single-use recovery codes for users who lose their authenticator. Only hashes are stored.
CREATE TABLE totp_recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  user_id     uuid NOT NULL,
  code_hash   text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);

ALTER TABLE refresh_tokens      ENABLE ROW LEVEL SECURITY;
ALTER TABLE totp_recovery_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refresh_tokens
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON totp_recovery_codes
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- ---------------------------------------------------------------------------------------------
-- The ONLY two cross-tenant reads in the system. At login (e-mail -> account) and at refresh
-- (token hash -> session) the tenant is not known yet, so RLS would hide the row. These narrow
-- SECURITY DEFINER functions return exactly one row for an exact key and nothing else; after that
-- every query runs inside withTenant(). They run with the schema owner's rights (which bypass RLS).
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION auth_find_user_by_email(p_email text)
RETURNS TABLE (
  id uuid, tenant_id uuid, email text, name text, role text, password_hash text,
  must_change_password boolean, failed_login_count integer, locked_until timestamptz,
  totp_enabled boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.password_hash,
         u.must_change_password, u.failed_login_count, u.locked_until, u.totp_enabled
    FROM users u JOIN tenants t ON t.id = u.tenant_id
   WHERE u.email = lower(p_email)
     AND u.deleted_at IS NULL
     AND t.deleted_at IS NULL AND t.status = 'ACTIVE'
$$;

CREATE FUNCTION auth_find_refresh_token(p_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT r.id, r.tenant_id, r.user_id FROM refresh_tokens r WHERE r.token_hash = p_hash
$$;

REVOKE ALL ON FUNCTION auth_find_user_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_find_refresh_token(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apex_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens, totp_recovery_codes TO apex_app;
    GRANT EXECUTE ON FUNCTION auth_find_user_by_email(text) TO apex_app;
    GRANT EXECUTE ON FUNCTION auth_find_refresh_token(text) TO apex_app;
  END IF;
END $$;
