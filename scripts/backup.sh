#!/usr/bin/env bash
# Backs up MongoDB (database dump) and the invoice PDFs. Run from cron / a scheduler.
#   MONGODB_URI=mongodb://... INVOICE_DIR=/data/invoices BACKUP_DIR=/backups ./scripts/backup.sh
set -euo pipefail
: "${MONGODB_URI:?MONGODB_URI is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
INVOICE_DIR="${INVOICE_DIR:-generated-invoices}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
mongodump --uri="$MONGODB_URI" --archive="$BACKUP_DIR/mongo-$STAMP.archive.gz" --gzip
if [ -d "$INVOICE_DIR" ]; then tar -czf "$BACKUP_DIR/invoices-$STAMP.tar.gz" -C "$INVOICE_DIR" .; fi
# Keep the 14 most recent of each kind.
ls -1t "$BACKUP_DIR"/mongo-*.archive.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t "$BACKUP_DIR"/invoices-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "Backup written: $BACKUP_DIR/mongo-$STAMP.archive.gz (+ invoices-$STAMP.tar.gz if present)"
