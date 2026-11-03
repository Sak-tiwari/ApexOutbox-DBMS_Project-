#!/usr/bin/env bash
# Restores a backup made by backup.sh. DESTRUCTIVE: --drop replaces existing collections.
#   MONGODB_URI=mongodb://... ./scripts/restore.sh backups/mongo-<stamp>.archive.gz [backups/invoices-<stamp>.tar.gz]
# Stop the api and worker first, restore, then start them: the worker's reconciler and requeue sweep
# will finish any onboarding / invoices that were in flight at backup time.
set -euo pipefail
: "${MONGODB_URI:?MONGODB_URI is required}"
ARCHIVE="${1:?usage: restore.sh <mongo archive> [invoices tarball]}"
INVOICE_DIR="${INVOICE_DIR:-generated-invoices}"
read -r -p "This DROPS and replaces data in $MONGODB_URI. Type 'restore' to continue: " answer
[ "$answer" = "restore" ] || { echo "aborted"; exit 1; }
mongorestore --uri="$MONGODB_URI" --archive="$ARCHIVE" --gzip --drop
if [ -n "${2:-}" ]; then mkdir -p "$INVOICE_DIR" && tar -xzf "$2" -C "$INVOICE_DIR"; fi
echo "Restore finished."
