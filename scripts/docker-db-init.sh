#!/usr/bin/env bash
# Runs once, inside the official postgres image, the first time the data volume is created.
# Creates the apex_owner / apex_app roles and the database by reusing scripts/db-setup.sh over the local socket.
set -euo pipefail
export ADMIN_DATABASE_URL="postgres://${POSTGRES_USER}@/postgres?host=/var/run/postgresql"
export DB_NAME="${APEX_DB_NAME:-apexoutbox}"
exec bash /scripts/db-setup.sh
