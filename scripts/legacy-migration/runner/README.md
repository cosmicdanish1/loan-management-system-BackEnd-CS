# Legacy -> production migration runner

Implements **THE RUN SHEET** (`../migration-v1.md`, section 44), with sections 42 and 43 and the per-table sections it points to.
One Node program, no new dependencies (`pg` and `dotenv` already belong to the backend; `sqlcmd` reads the legacy database exactly as `inspect.js` and `run-phase2.js` do).

**Dry run is the default.** Without `--execute` nothing is written to any Postgres database, and the legacy database is only ever read (every legacy statement passes `lib/sqlguard.js`; the Postgres side is a read-only session). No app (`src/`) code is changed. Existing scripts in `../` are untouched; everything new is in this `runner/` folder.

## Run it (all of these are safe, read-only)

From `backend/`:

```bash
node scripts/legacy-migration/runner/run-migration.js
```
Prints the plan: the pre-flight checks it would run, and the 15 steps with their section numbers, methods and checks. Touches no database.

```bash
node scripts/legacy-migration/runner/run-migration.js --check-legacy
```
Runs the **legacy pre-flight** (read-only SELECTs): dump date, freeze (no other session), duplicate member numbers, ledger codes in `headmaster`, PFLAG rule, voucher counters, tables present, plus the two input blockers (society's busrules values, go-live date). Writes `preflight.md/.json/.csv` under `reports/run-<time>/`.

```bash
node scripts/legacy-migration/runner/run-migration.js --check-legacy --report-lines --society-values=<file> --go-live-date=2026-11-04
```
Adds every **"report only" line** of the table sections (46 read-only queries, about 3 minutes; the `cheq-no-voucher` query alone takes ~2 minutes). Each prints the dump reference next to the live count.

```bash
node scripts/legacy-migration/runner/run-migration.js --baseline
```
Reads every table in scope and writes `baseline.json`: row count, sums of the money columns and a SHA-256 of all columns (about 3 minutes; ledger and demand tables dominate). Pass it to the load with `--baseline-file=`; the load fails if legacy changed after the baseline.

```bash
node scripts/legacy-migration/runner/run-migration.js --check-target --target-db=<NAME> --check-legacy --society-values=<file> --go-live-date=<date>
```
Opens a **read-only** session on the template database `<NAME>` and runs the target pre-flight (empty-target guard, schema drift, configuration rows, migrations list, trigger, new busrules columns). There is **no default target database** on purpose; this machine's `EMP_Espat_Society` is the test database and is never touched unless you name it.

`--help`, `--steps=1,2` (dry run only: restricts the printed plan), `--out-dir=`, `--expect-dump-date=`, `--gl-tolerance=`, `--migrations-dir=`, `--legacy-db=` (default `EMP_Espat_Society_dan`), `--legacy-server=` (default `.\SQLEXPRESS`, built with `String.fromCharCode(92)`).

## The real run (not part of the dry run; needs your go-ahead)

```text
node run-migration.js --execute --target-db=NAME --confirm-target=NAME --go-live-date=YYYY-MM-DD \
     --society-values=<json> --baseline-file=<baseline.json> [--backup-file=<pg_dump of the template>]
```
- Refuses unless the target name is typed twice, every blocker is closed, the target is an **empty template**, and a backup exists (taken by `pg_dump` unless `--backup-file` points to one).
- Steps 1 to 13 run in **one Postgres transaction**: any failed check rolls everything back and the target is still empty (rerun after fixing the cause). On success it commits and then runs step 15 (verification suite + review report).
- Step 14: `--phase2=check|dry|run` as separate commands (needs the committed data). `--phase2=run` also needs `--execute --confirm-phase2 --member-file=<pinned list>`.
- Repeat step 15 any time on a loaded target: `--verify-only --target-db=NAME` (add `--deep-hash` to re-hash every table).

The society's values go in a JSON file with exactly these 11 keys (never committed): `elnpenalrate, alnpenalrate, rlngracedays, elngracedays, alngracedays, rlnsmpct, elnsmpct, alnsmpct, rlnsmdiv, elnsmdiv, alnsmdiv`.

## Open blockers coded as explicit pre-flight failures (not worked around)

| Blocker | Where it fails | Spec |
|---|---|---|
| Duplicate member numbers in legacy `member_master` (`990042294`, `990042301`, `990042302` on the Nov dump) | `--check-legacy` and `--execute`: FAIL, names the numbers | 44.1(3), 13.4, Q21 |
| The society's 11 busrules values missing, incomplete, non-numeric, or a divisor of 0; go-live date missing | FAIL in every mode (also in the plain dry run) | 42.2, Q75 |
| Target is not an empty template (any data table with rows, `license_keys`, a user, `headmaster` rows other than `I1013`/`I1014`, any table outside the configuration group with rows) | `--check-target` / `--execute`: FAIL, lists the tables; **no delete step exists** | 44.1(4), 43 |

Also blocking in execute mode: another session on the legacy database, schema drift, a configuration table empty, migrations list differing from `src/migrations`, retirement trigger missing, the 11 busrules columns missing in the template.

## Step map (section 44.2 -> code -> spec)

| Step | What | Code | migration-v1.md |
|---:|---|---|---|
| pre | pre-flight | `lib/preflight.js` | 44.1 |
| 1 | 11 reference tables, exact copy | `lib/engine.js` `copyTable` | 42.1, 40, 41 (Q71, Q72, Q74) |
| 2 | `headmaster`, A-heads with blank PFLAG set to A | `lib/steps.js` + `derive.fixHeadPflag` | 32 (Q57, Q58) |
| 3 | `yearend`, `getworkingdate`, `bankopbal`, `voucher_master`, `busrules` + go-live row | `steps.js` `goLiveBusrules`, `derive.buildBusrulesGoLiveRow` | 33, 34, 35, 36, 42.2 |
| 4 | `office_master`, `wing_master` derived; `designation_master` empty | `steps.js` `runDeriveMasters` | 43.3 (Q78) |
| 5 | `member_master` insert-only, `full_name` + `cast_category` computed, trigger on | `steps.js` `memberMasterHooks` | 11, 13 (Q79) |
| 6 | `membercategory`, `fundsmaster`, `frs`, `frs_balance`, `suretymaster` | `copyTable` | 16, 17, 18, 38 |
| 7 | `ledger` (batches by `LedgerId`, ids kept, ordered hash), `ledger_data` | `copyTable` | 23, 24 |
| 8 | five loan tables, new-feature columns at the decided defaults | `copyTable` + `spec.constants` | 26-30 (Q48, Q49, Q51) |
| 9 | `demand_master`, `demand_masterdelete`, `demand_receipt`, `bank_cheq_master` | `copyTable` | 20, 21, 22, 41 |
| 10 | `member_balances` by head code (L1001, L1004; FRS L1002 + L1045) | `steps.js` `runMemberBalances`, `derive.buildMemberBalanceRows` | 19 |
| 11 | `share_monthly_balance` month-ends Nov 2019 .. last month | `runShareMonthly`, `derive.buildShareMonthlyRows` | 43.3 (Q77) |
| 12 | `tblcashbook` rows by the proven Cash Book rule + opening row 31-Oct-2019 | `runCashbook`, `derive.buildCashbookRows` | 39.7 (Q70) |
| 13 | counters: `voucher_master`, `sequence_master` (never lowered) | `runCounters` | 35.4, B20 (Q63) |
| 14 | equality check of loaded `ledger` + `loan_master` vs legacy, then the existing `bulk_ledger_replay.ts` unchanged via `run-phase2.js` | `lib/phase2.js` | 31 (Q54-Q56) |
| 15 | verification suite + review report | `lib/verify.js`, `lib/report.js`, `lib/reportqueries.js` | 44.3 |

Per-step baselines: every copy table is checked for **row count, sums of its money columns (SQL on both sides) and a SHA-256 over all columns** (order-independent multiset hash; the ledger additionally by an ordered hash in `LedgerId` order), source rows against rows read back from the target inside the same transaction. The ledger also gets total debits/credits, per-head totals, voucher count and highest `LedgerId`/`TRANS_NO` in the suite.

## Tests

```bash
node --test "scripts/legacy-migration/runner/tests/*.test.js"
```
38 tests, no database of any kind contacted: pure derivation rules (balances by head code, share months, cash book rule, opening row, counters, busrules go-live row, cast category, trigger emulation), hashing, the SQL guards, the copy engine end-to-end against an in-memory legacy and target (including tampered rows, drift, non-empty target, read-only refusal), the empty-target guard and the report generator.

## What was verified against real data (read-only, 2026-11-12) and what was NOT

Verified on the live legacy database (read-only): every legacy-side SQL statement in the runner runs; all 34 table counts and all sums equal section 44/the table sections (e.g. `LOAN_AMT` 159,83,56,103, `CDOPBAL` 35,99,99,928, credits - debits 2,42,044, 74,194 vouchers, cash in hand -65,61,491); the pure cash book rule gives **23,632 rows, the three printed dates equal the printouts, and the opening row comes out at the cash payment 4,53,599 and transfer receipt 3,88,024 of section 39.7**; member balances for `990042274/73/76` equal 0 / 2,32,748 / 18,502; the 46 report queries reproduce the section reference counts (two lines of the spec are not implemented, see AMBIGUITIES.md); the three duplicate member numbers are found.

**Not executed: every Postgres-side statement of steps 1-13 and of the verification suite**, because the only Postgres database on this machine is the test database, which was off limits. The copy engine and the guards are covered by the fake-target tests, but the derived steps' SQL (4, 10-13), `verifyLedger`, `verifyLoans` and the pre-flight SQL have only been reviewed by reading. **Rehearse `--execute` once on a scratch restore of the template** (a throw-away database, not `EMP_Espat_Society`) before the real day.

Phase 2 caveat: `bulk_ledger_replay.ts` is hard-wired to `localhost:5432`, database `EMP_Espat_Society`, user `postgres` (password from `DB_PASSWORD`) and legacy `EMP_Espat_Society_dan`. The hook refuses to start it against any other target; on this machine that name is the test database.
