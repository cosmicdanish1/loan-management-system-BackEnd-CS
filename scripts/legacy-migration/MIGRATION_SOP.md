# Legacy → Postgres Loan Migration — Standard Operating Procedure

Two-phase process. Phase 1 copies raw legacy tables as-is. Phase 2 replays
real repayment history through the live app's own repayment engine,
detecting loan consolidations along the way. Run in this order, always.

All commands run from `backend/` in a terminal (PowerShell or Git Bash both
work — commands below are PowerShell; swap `$env:VAR="x"` for
`VAR=x` if using Git Bash).

---

## 0. One-time prerequisites (already set up, listed for reference)

- Postgres connection: read from `backend/.env` (`DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`)
- Legacy SQL Server: `.\SQLEXPRESS`, database `EMP_Espat_Society_dan`, via
  `C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn\SQLCMD.EXE`
  (Windows auth — no password needed)
- Node + npm installed, `npm install` already run in `backend/`

---

## 1. Wipe existing loan data from Postgres

**Always dry-run first** — it prints exactly what would be deleted without touching anything:

```bash
node scripts/legacy-migration/wipe-all-loan-data.js
```

Check the row counts look sane, then commit for real:

```bash
node scripts/legacy-migration/wipe-all-loan-data.js --execute
```

This clears `loan_master`, `loan_pending`, `loan_masterhistory`, `loan_product`,
`loan_balance_history`, `loan_repayment_ledger`, `loan_rb_schedule`,
`loan_nominee`, `legacy_replay_batch_log`, `suretymaster`, `loan_opbal`,
`loan_interest_master`, `loan_monthly_balance`, `loan_accounts` completely,
filters `ledger` to only `RLN`/`ALN`/`ELN` rows, and zeroes just the loan
columns on `member_balances`. It does **not** touch `demand_master`,
`transactions`, `vouchers`, or `busrules`.

⚠️ No backup is taken by this script. Only run `--execute` when you're sure.

---

## 2. Phase 1 — raw copy from legacy

**Scope to specific members** (recommended for any test run) — put one `mbno`
per line in a text file, e.g. `scripts/legacy-migration/reports/my_test_members.txt`, then:

```bash
$env:SKIP_BACKUP="1"
$env:MBNO_FILE="scripts/legacy-migration/reports/my_test_members.txt"
node scripts/legacy-migration/migrate-all-members.js --execute
```

**Full population** (all ~8,555 legacy members) — omit `MBNO_FILE`:

```bash
$env:SKIP_BACKUP="1"
node scripts/legacy-migration/migrate-all-members.js --execute
```

(Remove `$env:SKIP_BACKUP="1"` — or set it to nothing — if you DO want the
script's automatic `pg_dump` backup before it runs. Skipped by default in
this SOP because Postgres currently only holds test data.)

Watch for `Flagged: N` in each batch's output — 0 is expected. Any flags mean
a member's row shape didn't match what the script expected; check
`scripts/legacy-migration/reports/all-member-migration-result.json` for detail.

This step is pure column-copy — no repayment logic, no consolidation
detection. It's the fast phase (minutes, not hours).

---

## 3. Phase 2 — repayment replay + consolidation detection

This is the slow phase (real per-member computation, calls into the actual
app's repayment service). For the full 8,555-member population, budget
**several hours**.

**Scope to specific members** (same file as Phase 1, or a different one):

```bash
$env:DRY_RUN="false"
$env:CONFIRM_LIVE_RUN="yes-i-mean-it"
$env:MBNO_FILE="scripts/legacy-migration/reports/my_test_members.txt"
node scripts/legacy-migration/run-phase2.js > scripts/legacy-migration/reports/phase2-run.log 2>&1
```

**Full population** — omit `MBNO_FILE`:

```bash
$env:DRY_RUN="false"
$env:CONFIRM_LIVE_RUN="yes-i-mean-it"
node scripts/legacy-migration/run-phase2.js > scripts/legacy-migration/reports/phase2-run.log 2>&1
```

**Always dry-run first** on a new scope before the real run — just drop
`CONFIRM_LIVE_RUN` (or set `DRY_RUN` to anything other than `false`) and it
computes and logs everything without writing to Postgres:

```bash
$env:MBNO_FILE="scripts/legacy-migration/reports/my_test_members.txt"
node scripts/legacy-migration/run-phase2.js
```

### If it gets interrupted partway through

It's safe to just re-run the exact same command. Each member is checkpointed
in `legacy_replay_batch_log` — members already marked `done` are skipped;
members marked `failed` (including from a killed process) are retried
automatically.

### Reading the log afterward

```bash
grep -E "^=====|Members processed|Repayments replayed|Consolidations applied|Flags raised" scripts/legacy-migration/reports/phase2-run.log
```

- **Consolidations applied** — count of same-type/cross-type loan top-ups detected and replayed. Higher is normal for members with repeat loans.
- **Flags raised** — anything the script couldn't resolve automatically. Read them:

```bash
grep "^\[" scripts/legacy-migration/reports/phase2-run.log
```

Flags you'll routinely see and can ignore (not bugs):
- `has invalid loan_amt (₹0) in the legacy source — excluded` — legacy placeholder rows, correctly skipped.
- `SCHEDULE_EXTENDED case=... real total exceeds declared loan_amt` — real repayments exceeded the legacy record's stated amount; the script extends the schedule to fit the real money. Normal for many legacy cases.
- `Case ... balance mismatch after replay: expected ~₹X, got ₹Y (diff ₹Z)` where Z is small (under ~₹100) — rounding-level, ignore.
- `Unattributed CR ₹X on DATE — next case not disbursed until Y` — a real payment landed before its case existed in our data; usually means an even older, no-longer-present legacy case is missing. Needs manual review but is a legacy data gap, not a script bug.

Flags worth investigating if the diff is large (hundreds/thousands of rupees):
- `Case ... balance mismatch after replay: expected ~₹X, got ₹Y (diff ₹Z)` with large Z.
- `Consolidation-close ... is the receiving case itself, not a predecessor` — a real, handled edge case (predecessor was already fully repaid before the consolidation date); just confirms the topup still applied correctly.

### Important tenure rule

Phase 1 copies the legacy `LOAN_MASTER.NO_OF_INSTAL` value as-is. Phase 2 may
add schedule slots only for an open case whose replayed payments outran its
calendar schedule. It must never change the original tenure of a case that was
explicitly closed by consolidation. The replay script enforces this by
excluding closed cases from the `SCHEDULE_SLACK_ADDED` branch.

For every migration, compare the source and target tenure values for
closed/consolidated cases:

```sql
SELECT MBNO, LOANCASENO, LOANTYPE, LOAN_AMT, NO_OF_INSTAL, INSTAL_AMT, BALANCE
FROM LOAN_MASTER
WHERE MBNO = 610020500 AND LOANCASENO IN (15589, 19855)
ORDER BY LOANCASENO;
```

The successor may legitimately have a higher `loan_amt`/`balance` in
Postgres when it absorbs a predecessor's remaining debt. Its `no_of_instal`
must remain the source value unless an open-case schedule extension is
explicitly reported in the Phase 2 log.

---

## 4. Verify results

Quick per-member export to CSV for manual checking (adjust the mbno list):

```bash
node -e "
const { Client } = require('pg');
require('dotenv').config();
const c = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
c.connect().then(async () => {
  const mbnos = ['MBNO1','MBNO2'];
  const lm = await c.query('SELECT mbno, loancaseno, loantype, loan_amt, balance, no_of_instal, instal_amt, consolidated_into_loancaseno, payment_date FROM loan_master WHERE mbno = ANY(\$1) ORDER BY mbno, loantype, payment_date', [mbnos]);
  console.table(lm.rows);
  await c.end();
});
"
```

Or just open `scripts/legacy-migration/reports/<your CSV export>` in Excel.

What to check per case:
- `balance` — should be 0 for any case with a `consolidated_into_loancaseno` set (it was folded into the successor).
- `consolidated_into_loancaseno` — the case number it rolled into, if any.
- The successor case's `balance` should reflect the combined outstanding principal.

---

## 5. Full-population run checklist

1. `node scripts/legacy-migration/wipe-all-loan-data.js` (dry-run) → review → `--execute`
2. `node scripts/legacy-migration/migrate-all-members.js --execute` (no `MBNO_FILE`, `SKIP_BACKUP=1`)
3. Confirm `Flagged: 0` in Phase 1's output
4. `node scripts/legacy-migration/run-phase2.js` (no `MBNO_FILE`, `DRY_RUN=false CONFIRM_LIVE_RUN=yes-i-mean-it`), redirected to a log file
5. This takes hours — run it in a terminal you can leave open, not inside a session that might get closed
6. When done, check `Flags raised` count and read through them (see §3 above for what's normal vs worth reviewing)
7. Spot-check a sample of members' `loan_master` rows against the CSV export method in §4
