#!/bin/bash
# Usage: _run_reset_batch.sh <label> <member list file>
# Backup -> delete members -> Phase 1 copy -> Phase 2 replay (live). Logs to reports/reset-<label>-*.log
set -e
cd "$(dirname "$0")/../.."
LABEL="$1"; LIST="$2"; R=scripts/legacy-migration/reports
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
PW=$(grep -E "^DB_PASSWORD=" .env | cut -d= -f2-)
PGPASSWORD="$PW" "C:/Program Files/PostgreSQL/18/bin/pg_dump.exe" -Fc --no-owner --no-acl -h localhost -p 5432 -U postgres -d EMP_Espat_Society -f "backups/pre-first-due-reset-$LABEL-$STAMP.dump"
echo "backup: backups/pre-first-due-reset-$LABEL-$STAMP.dump $(stat -c %s backups/pre-first-due-reset-$LABEL-$STAMP.dump 2>/dev/null || wc -c < backups/pre-first-due-reset-$LABEL-$STAMP.dump) bytes" > $R/reset-$LABEL-status.log
MBNO_FILE=$LIST node scripts/legacy-migration/delete-members-from-list.js --execute > $R/reset-$LABEL-delete.log 2>&1
echo "deleted: $(tail -1 $R/reset-$LABEL-delete.log)" >> $R/reset-$LABEL-status.log
MBNO_FILE=$LIST SKIP_BACKUP=1 node scripts/legacy-migration/migrate-all-members.js --execute > $R/reset-$LABEL-phase1.log 2>&1
echo "phase1 done: $(grep -E 'Members:' $R/reset-$LABEL-phase1.log)" >> $R/reset-$LABEL-status.log
DRY_RUN=false CONFIRM_LIVE_RUN=yes-i-mean-it MBNO_FILE=$LIST node scripts/legacy-migration/run-phase2.js > $R/reset-$LABEL-phase2.log 2>&1 || true
echo "phase2 done: $(grep -E 'Members processed|Repayments replayed|Flags raised' $R/reset-$LABEL-phase2.log | tr '\n' ' ')" >> $R/reset-$LABEL-status.log
echo FINISHED >> $R/reset-$LABEL-status.log
