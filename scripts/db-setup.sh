#!/usr/bin/env bash
# Creates the two database roles and the database for ApexOutbox. Idempotent.
#
#   apex_owner  owns the schema and runs migrations (never used by the running app)
#   apex_app    what the API/worker connect as: no superuser, no BYPASSRLS, not the table owner,
#               so Row-Level Security always applies to it
#
# Usage (as a Postgres superuser URL):
#   ADMIN_DATABASE_URL=postgres://postgres:...@localhost:5432/postgres \
#   APEX_OWNER_PASSWORD=... APEX_APP_PASSWORD=... DB_NAME=apexoutbox bash scripts/db-setup.sh
set -euo pipefail

: "${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL (superuser connection string)}"
: "${APEX_OWNER_PASSWORD:?set APEX_OWNER_PASSWORD}"
: "${APEX_APP_PASSWORD:?set APEX_APP_PASSWORD}"
DB_NAME="${DB_NAME:-apexoutbox}"

if [[ ! "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "DB_NAME must match ^[a-z_][a-z0-9_]*$" >&2
  exit 1
fi

psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v owner_pw="$APEX_OWNER_PASSWORD" -v app_pw="$APEX_APP_PASSWORD" -v dbname="$DB_NAME" <<'SQL'
SELECT format('CREATE ROLE apex_owner LOGIN PASSWORD %L', :'owner_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apex_owner') \gexec
SELECT format('ALTER ROLE apex_owner PASSWORD %L', :'owner_pw') \gexec

SELECT format('CREATE ROLE apex_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', :'app_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apex_app') \gexec
SELECT format('ALTER ROLE apex_app PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'app_pw') \gexec

SELECT format('CREATE DATABASE %I OWNER apex_owner', :'dbname')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'dbname') \gexec
SQL

echo "Roles and database '$DB_NAME' are ready. Next: npm run db:migrate"
