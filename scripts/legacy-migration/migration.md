# Legacy loan migration — incident and replay notes

**Last updated:** 2026-10-03  
**Purpose:** Keep an operator-readable record of the Phase 2 replay issue, corrective logic, migration state, and safe recovery procedure. This is a working migration log; append future changes rather than replacing earlier context.

## What this migration does

The migration has two distinct phases:

1. **Phase 1** copies the source member/loan records from legacy SQL Server into PostgreSQL.
2. **Phase 2** replays actual legacy loan receipts through the application's repayment service and creates schedule-version records used by the new application.

The three members recently migrated individually remain excluded from the current population replay: `610033146`, `610032638`, and `610026861`. The pinned Phase 2 list is `reports/full-population-except-recently-migrated-20260925-152137.txt` (8,552 member IDs; the current replayable source scope is smaller because only members with relevant loan receipts are processed).

## Incident: absurd installment terms from a one-off residue

### Previous behavior

For each origination/consolidation schedule boundary, Phase 2 chose the first positive principal component after the slot-delay month:

```text
monthly principal = first positive post-slot principal component
installment count = ceil(schedule opening principal / monthly principal)
```

That treated tiny final balances or adjustment fragments as a normal monthly principal. For example, case `13790` for member `610018530` had a `₹3` principal residue after a `₹1,29,997` principal payoff. The script inferred:

```text
₹1,30,000 / ₹3 = 43,333.33  -> 43,334 installments
```

`loan_master.no_of_instal` is `smallint` (maximum 32,767), so the live replay failed when it tried to copy the inferred count into `loan_master`. `loan_schedule_versions.installment_count` accepted 43,334 first, and that schedule row had been autocommitted before the later failure. This is why a failed batch can leave artifacts even though the batch status is `failed`.

Other examples from the focused dry-run:

| Member / case | Misleading row | Normal pattern / interpretation | Correct handling |
|---|---:|---|---|
| `610032479` / `11744` | ₹6 principal on 2021-01-16 | ₹7,692 principal repeated from February 2021; later schedule changes belong to later boundaries | Seed this version with ₹7,692, not ₹6 |
| `610018530` / `13790` | ₹3 principal on 2021-03-12 | A ₹1,29,997 principal payoff had already left only a residue | Do not invent a recurring schedule from the residue; flag it for review |
| `610031609` / `16327` | ₹2 principal on 2023-05-12 | ₹4,167 principal repeats from June 2023 | Seed with ₹4,167 |
| `610032825` / `17918` | ₹8 principal on 2025-01-16 | ₹5,000 principal repeats from February 2025 | Seed with ₹5,000 |

These examples support the business rule that an installment seed is the first **normal recurring** principal after the applicable slot delay—not the smallest first positive component and not the most frequent amount across unrelated schedule versions.

## Corrections now in the replay implementation

The operator entry point remains the JavaScript wrapper `run-phase2.js`; schedule reconstruction is implemented in `src/scripts/phase2/bulk_ledger_replay.ts`.

1. **Recurring principal seed:** `schedule-seed.util.ts` selects the earliest rounded principal amount that recurs in another distinct calendar month within six months. Singleton residues/adjustments are not accepted as EMI evidence.
2. **Slot-delay payroll at every schedule boundary:** BSP deductions from the effective date up to (but not including) the first due month are predecessor-payroll credits at both origination and consolidation boundaries. They remain visible/auditable, but are flagged so they neither reduce current-loan principal nor advance its EMI schedule. The loan's opening principal remains the full boundary principal.
3. **Fully repaid before first due:** if current-loan pre-due principal exhausts the opening principal, no future schedule is created.
4. **Consolidation boundaries on the same effective date:** duplicate journal matches for one receiving loan/date/head create one schedule boundary. The opening balance still includes the complete sum of detected consolidation top-ups.
5. **Database range guard:** any inferred count over the `loan_master.no_of_instal` smallint limit (32,767) is refused and logged as `SCHEDULE_VERSION_NOT_BUILT`; the script does not widen the database type to conceal a bad inference.
6. **Interrupted-run recovery:** before rebuilding a case's derived schedule versions, Phase 2 replaces the prior versions; if no valid version can be inferred, it removes stale versions for that case. Existing exact receipt fingerprints posted by `phase2-replay` are matched and skipped on retry, preventing duplicate principal/interest rows after a member-level failure. When a matched historical row is newly identified as predecessor payroll, its flag is corrected and its principal effect is restored to the current loan and member balance. Consolidation top-ups are set to the expected effective capacity rather than added repeatedly. Consolidation close ledger rows are checked before insertion.
7. **Audit output:** replay logs now show total, principal, and interest for each source repayment to make the seed and allocation auditable.

## Test evidence

Focused unit tests cover:

- skip a one-off ₹6.93 residue and choose recurring ₹8,884;
- do not infer an installment from a one-off ₹3.59 payoff residue;
- use the first recurring principal in a schedule window rather than a later amount's frequency;
- require recurrence in separate calendar months.

The focused Jest suite passed (4/4). The pure schedule utility type-check passed. A repository-wide `tsc --noEmit` still reports existing unrelated errors in backup service specs and e2e imports; do not attribute those errors to this migration change.

The four-member Phase 2 dry-run produced the expected normal seeds for cases `11744` (₹7,692), `16327` (₹4,167), and `17918` (₹5,000), while refusing the ₹3 residue in case `13790`. Some non-schedule audit flags also remain and are not silently suppressed. A new full-scope rescan after the code change was stopped at member `610028474` because extraction is very slow; it made no writes. The earlier full dry-run remains available as the population-level baseline.

The focused two-member dry-run after the slot-delay correction shows:

| Member / case | Effective date | Delay / first due | Pre-due receipt | Result |
|---|---|---|---:|---|
| `610025717` / `16708` | 2023-01-10 | 2 months / 2023-04 | 2023-03-16, ₹5,375 (₹5,000 principal + ₹375 interest) | Flagged as predecessor payroll; opening principal remains ₹50,000; expected ending principal ₹5,000 |
| `610025740` / `18175` | 2024-03-22 | 2 months / 2024-06 | 2024-05-14, ₹6,125 (₹5,000 principal + ₹1,125 interest) | Flagged as predecessor payroll; opening principal remains ₹2,00,000; expected ending principal ₹5,000 |

The same-month boundary test and recurring-principal tests pass. The focused Jest suite passes 7/7. The focused dry-run is read-only and reports no migration-service writes.

## PostgreSQL state and recovery context

At the time of the first replay attempt, the pinned Phase 2 live replay was incomplete:

- pinned members: 8,552;
- source members in replay scope: 3,639;
- batch log: 916 `done`, 1 `failed` (`610018530`), remainder not yet marked complete;
- failed error: installment count `43334` exceeded PostgreSQL `smallint`;
- the failed member had already committed exact Phase 2 receipts for earlier cases `667` and `12055` (5 and 3 rows respectively), so blindly replaying that member would duplicate them;
- a stale schedule version for case `13790` / member `610018530` with count 43,334 existed and must be removed by the corrected replay;
- no schedule-version count above 32,767 should remain after a successful corrected replay.

The relevant pinned list and previous run output are retained under `reports/`. Before resuming, a fresh PostgreSQL checkpoint was created and verified:

```text
backend/backups/phase2-pre-resume-2026-09-25T16-16-32-115Z.dump (88,266,029 bytes)
```

That checkpoint represents a **partial replay state**, not a clean pre-Phase-2 database. The earlier checkpoint (`phase2-replay-checkpoint-2026-09-25T13-49-50-722Z.dump`) is also retained. After the subsequent interrupted live attempt, a newer checkpoint was created:

```text
backend/backups/phase2-pre-slot-delay-fix-2026-09-25T22-20-00.dump (88,371,752 bytes)
```

Do not restore the earlier pre-Phase-1 backup as a shortcut: it predates the raw migration and would remove valid Phase 1 records. Do not rerun Phase 1 or wipe all loan data to repair a Phase 2 interruption.

### Second incident: slot-delay receipts caused false fully-repaid errors

The interrupted corrected-live attempt reached 1,021 `done` members and 28 `failed` members. The failures shared `Loan … is already fully repaid`. On cases such as member `610025717` / case `16708`, the migration subtracted the pre-first-due ₹5,000 principal from the new loan's opening balance, then recorded the same row as an ordinary repayment. The repayment service counted it again from the ledger history; later receipts then appeared to overrun the schedule. Another case (`610025740` / `18175`) showed why exact old-EMI matching is insufficient: the predecessor payroll total differed from the previous EMI, but its date was still within the slot-delay window.

The business rule is now calendar-boundary based, not amount-match based:

```text
predecessor payroll credit = effective_date <= payment_date
                             AND payment_month < first_due_month
                             AND payment_date < next schedule boundary (if present)
current-loan opening principal = boundary principal
```

The marker `is_payroll_lag_credit=true` keeps these receipts available for audit/closure adjustment and excludes them from current-loan principal and installment pools. The repayment API now permits an explicitly flagged predecessor-payroll receipt to be recorded even when current principal is already settled; this branch does not lower or reopen the loan balance. The migration can revisit completed members (`REPLAY_COMPLETED=true`), flip exact already-committed receipts to the correct marker without duplicating them, restore their principal effect, and rebuild schedules.

**Observed partial-run status after interruption:** 1,021 `done`, 28 `failed`. A subsequent short retry reached 1,019 `done`, 30 `failed` before it was stopped; the status changed because two formerly completed members failed during forced replay. These counts are snapshots, not a final migration result.

### Third incident: duplicate replay receipts and case-number collisions

The short retry showed that some prior attempts had already left multiple identical rows committed in PostgreSQL. A read-only audit found 956 duplicate replay fingerprints (4,305 excess rows before source reconciliation). Examples included member `30019263`, case `17896` with 208 replay rows totalling ₹2,13,644 principal, and member `30020860`, case `44` with 119 replay rows. The exact valid multiplicity must be compared with the legacy source; not every repeated fingerprint is automatically a duplicate because same-day split receipts can legitimately repeat.

The replay was intended to count each complete fingerprint (receipt/date, total amount, principal, interest, penalty) in the legacy input, retain only that source-supported number of exact target copies, and remove only provably excess `phase2-replay` rows. The next live attempt showed this matching rule is too strict for rows created by earlier attempts: legacy-replay ledger rows can have the same case/date receipt identifier but different component splits or application-computed penalties. Those rows do not match the new complete fingerprint, so they are neither reconciled nor safely skipped. Do not treat the earlier fingerprint-cleanup implementation as having resolved the duplicate incident.

The repayment calculator also had loan-ledger aggregates scoped by member and case but not loan type. Since legacy case numbers can collide across `RLN`/`ALN` (or other types) for one member, the service now scopes installment pools, penalties, version principal, payroll-lag offsets, repayment history, and RB schedule rows by all three keys: member, type, and case. This prevents a sibling loan's receipts from making the selected loan appear already paid.

## Safe resume procedure

1. Confirm no `run-phase2.js` / `bulk_ledger_replay.ts` live process is running.
2. Verify the pinned list still contains exactly the intended 8,552 members and excludes the three individually migrated IDs above.
3. Take and verify a new PostgreSQL backup of the current partial state.
4. Run the four-member dry-run and the full pinned-population dry-run. Review all `ERROR`, `SCHEDULE_VERSION_NOT_BUILT`, and balance-mismatch flags. The latter can be legitimate source-data exceptions, but each must be understood before sign-off.
5. Query `legacy_replay_batch_log`. Because the slot-delay rule changes both prior completed rows and failed/unprocessed members, use `REPLAY_COMPLETED=true` for the corrected replay. Exact existing receipts are skipped after any needed payroll-lag reclassification; top-ups and schedule versions are idempotently rebuilt.
6. Resume with `DRY_RUN=false`, `CONFIRM_LIVE_RUN=yes-i-mean-it`, `REPLAY_COMPLETED=true`, and the same `MBNO_FILE` pinned list. The stopped run is in `reports/phase2-full-except-recently-migrated-20260925-corrected-live.log` and matching `.err.log`; the focused dry-run is `reports/slot-delay-focused-dryrun.log`. Write a new run log for the retry and monitor until all in-scope members finish.
7. Verify: all in-scope members are `done` or have explicitly reviewed exclusions; no schedule count exceeds 32,767; no duplicate exact migration receipt exists for a member/case/date; excluded members remain unchanged; slot-delay rows are flagged and do not reduce active-loan principal; and active loan balances agree with the replay audit.

If validation fails, stop the run. Restore only from a verified backup after assessing all writes since that backup; never use a global loan-data wipe as an ad-hoc rollback.

## Future changes

For every later migration-rule change, append: the date, issue and source evidence, exact old/new formula, affected member/case examples, code paths changed, dry-run counts/flags, live execution scope, backup identity, and post-run database checks. Keep credentials and connection strings out of this document and reports shared outside the trusted operator environment.

## 2026-09-28: early-closure quote failed on reducing-balance schedule schema

The Loan Early Closure screen failed to load a quote for member `610033022` / emergency loan case `18445`. The server error was `column "loantype" does not exist` while reading the reducing-balance schedule. Application code was already filtering schedule rows by member, loan type, and case, but the deployed PostgreSQL `loan_rb_schedule` schema had no `loantype` column and keyed rows only by case/installment. This was a target schema/application-version mismatch; it was not caused by migrating this member's loan transactions.

Fix:

- Added `loantype` to the fresh-install schedule migration and added a follow-up migration, `AddLoanRbScheduleLoanType1790553600000`, to safely upgrade existing databases.
- The migration verifies each existing schedule row maps to exactly one `loan_master` row by member and case before backfilling loan type. It aborts on ambiguous/missing matches or conflicting pre-existing types, rather than guessing.
- Replaced the case-only uniqueness with `(mbno, loantype, loancaseno, installment_no)` and added a matching lookup index so identical case numbers across members/types do not collide.
- Updated schedule creation, repayment totals, and reversal cleanup to use the same member/type/case key.

The target schedule table contained zero rows when the migration was applied, so no historical schedule values required backfill and no member ledger/repayment rows were rewritten. Only this schema migration was run; no bulk member migration or loan closure transaction was performed.

Verification: backend TypeScript build passed. The migration was applied to `EMP_Espat_Society`. The read-only early-closure quote call for case `18445` then succeeded for 28-Sep-2026, returning outstanding principal ₹1,05,833, closure interest ₹40,236, penalty ₹0, and total ₹1,46,069. This was a quote calculation only; it did not post a payment or close the loan. The UI's generic “Failed to load closure quote” message was masking the SQL error returned by the server.

## 2026-09-28: fresh migration of member `610028658` from restored SQL Server source

The first single-member migration pass started before the operator restored the intended legacy SQL Server state. Its Phase 1 copied 624 rows, and Phase 2 completed against that earlier source version. After the operator reported the restore, the restored SQL Server source was rechecked: the single-member Phase 1 dry run now saw 647 rows (including 80 `demand_master`, 135 `demand_masterdelete`, and 384 `ledger` rows, versus the earlier 77, 130, and 369 respectively).

To ensure a genuinely fresh result, a verified full PostgreSQL backup was taken, then only member `610028658` was removed from member-scoped Postgres tables. The reset deleted 669 rows across 18 populated tables, including the prior replay batch, 43 prior repayment rows, 3 loan-master rows, and the prior schedule version. The full backup is `backups/pre-single-member-reset-610028658-restored-source-2026-09-28T12-21-00-899Z.dump` (91,505,315 bytes). The subsequent phase-1 runner also took its normal pre-copy full backup: `backups/pre-single-member-migration-610028658-2026-09-28T12-21-39-761Z.dump` (91,494,961 bytes).

The final run was restricted to `610028658`:

- Phase 1 copied and fingerprint-verified 647 source rows across all 15 legacy member tables, with no skipped tables or copy flags.
- Phase 2 dry run and live replay each processed one member, found 46 source repayment receipts, and detected no consolidations.
- Two zero-amount legacy loan placeholders (case `2086` / `RLN` and case `3018` / `ALN`) were correctly excluded and remain flagged; they are not valid disbursed loans.
- Valid active loan case `16261` / `RLN` has original principal ₹10,00,000, fixed principal ₹15,385, and 65 installments. Of the ₹8,10,452 principal attributed across 46 replay rows, one ₹15,385 payroll-lag credit is predecessor payroll and excluded from current-loan principal. Thus current-loan principal paid is ₹8,10,452 − ₹15,385 = ₹7,95,067 and remaining principal is ₹10,00,000 − ₹7,95,067 = ₹2,04,933, matching Postgres `loan_master.balance`.
- Post-run Postgres verification found 46 `loan_repayment_ledger` rows, one payroll-lag marker, one effective schedule version, replay batch status `done`, and no `loan_rb_schedule` rows. Current copied source row counts match the Phase 1 report.

The Phase 2 output is preserved at `reports/phase2-610028658-restored-source-live-20260928.log`. No other member was selected by either migration phase. The process was rerun only after the restored SQL Server source was confirmed through a fresh source extraction.

## 2026-09-25: live resume stopped on duplicate-receipt regression

At the user's request, a live resume was started without another full-population dry run, using the pinned 8,552-member list (3,639 matched the current legacy scope; the three previously migrated members were excluded). The run log is `reports/full-population-live-resume-20260925.log`. It was stopped after 30 member blocks when the previously observed failures recurred: member `30019263` / case `17896` and member `30020860` / case `44` both hit `Loan … is already fully repaid` while processing a source receipt.

At interruption, the log showed 26 member balance-summary reconciliations, 13 schedule-version events, zero new repayment service writes, and zero duplicate rows removed. PostgreSQL still reported 1,019 `done` and 30 `failed` batch-log rows. The failed member examples have far more existing principal than their opening loan amounts (case `17896`: ₹2,16,707 principal against ₹1,44,444 opening amount; case `44`: ₹1,35,708 against ₹94,058). Their older replay rows reuse date-based `LR-<case>-<date>` receipt numbers but contain different principal/interest/penalty splits across retries, so full-amount/component fingerprint equality does not identify the historical copies. The receipts shown in the focused dry run also have a changed principal/interest split from the stored rows (for example, case `17896` on 2024-01-11), confirming that receipt-number/date alone is not sufficient to safely delete or treat rows as an exact match when multiple same-day receipts are possible.

Important transaction finding: `bulk_ledger_replay.ts` opens an outer query-runner transaction, but its reconciliation/schedule mutations use `AppDataSource.query`, and `LoanRepaymentService.recordLoanRepayment` opens and commits its own transaction for every receipt. Therefore the outer transaction does **not** make an entire member atomic. A member error can leave earlier schedule/receipt mutations committed. In this interrupted attempt no new repayment rows were logged, but schedule-version and member-balance-summary writes may already have committed. Do not assume that rolling back the outer query runner reverses those writes.

Do not restart the full replay until the idempotency strategy is redesigned against the historical rows and the transaction boundary is made explicit. The existing checkpoint `backend/backups/phase2-pre-idempotent-dedupe-2026-09-25T22-35-00.dump` is a verified pre-attempt snapshot; assess all later writes before considering any restore. The full dry run was intentionally skipped at the user's request; focused validation and targeted source/target reconciliation are still required before another live run.

## 2026-09-26: user-authorized full-population migration attempt

The user explicitly requested proceeding with the all-member migration and skipping the full dry-run phase to avoid further delay. The full replay was run with `DRY_RUN=false`, `CONFIRM_LIVE_RUN=yes-i-mean-it`, and `REPLAY_COMPLETED=false`, using `reports/full-population-pending-20260925.txt`. This input excluded the three members separately migrated earlier (`610033146`, `610032638`, `610026861`). The legacy source matched 3,639 members in the pinned population. Already-`done` members and the 30 pre-existing `failed` members were not replayed again; the run attempted the remaining 2,593 matched members.

Run result:

- 2,592 of 2,593 attempted members completed successfully; one new member failed.
- Final target batch-log status for the 3,639 in-scope members: 3,608 `done`, 31 `failed`, zero unaccounted/pending.
- 98,895 repayments replayed; 3,297 consolidations applied; 12,238 migration flags raised for audit/review (these flags are not equivalent to migration failures).
- The new failure was member `990042235`, case `10169`: the repayment service rejected the source receipt because the target loan was already fully repaid. Read-only inspection found an `ALN` opening amount of ₹5,000, target balance `-₹5,000`, and no repayment-ledger rows, indicating the inconsistency exists in the target opening state rather than being caused by a newly inserted repayment in this attempt.
- The 30 prior failures were not retried. They include already-fully-repaid/over-replayed cases requiring individual source-to-target reconciliation; known examples are member `30019263` / case `17896` and member `30020860` / case `44`.

Artifacts:

- Live log: `reports/full-population-pending-live-20260925.log`
- Exception data extract: `reports/phase2-exceptions-data-20260926.json`
- Exception workbook: `../../../../outputs/phase2-migration-2026-09-26/migration-exceptions.xlsx`

The exception workbook has a summary plus one row per failed member with the member/case identifiers, recorded failure reason, review note, and available batch-log context. Treat this as an exceptions worklist, not as permission to replay or delete data. Do not retry failed members until each case's opening balance and existing receipt history are reconciled against the legacy source. No global wipe was performed.

## 2026-10-03: first EMI due month was stored one month late; payments now carry their source

**Issue.** Every migrated schedule version had `first_due_month` one month later than the real first deduction. For member `610032487` / ALN case `17681` (taken 04-Nov-2023, early slot) the stored first due month was Jan-2024; the legacy ledger shows the loan's first EMI month is Dec-2023, and the member missed Dec-2023 and Jan-2024 (first deduction 15-Feb-2024). Dec-2023 therefore could not appear as an unpaid instalment, and its late months (34) were missing from penalties and closure quotes.

**Source evidence.**

- The original replay (v1.4.0, 2026-09-27) computed `first_due = new Date(year, month + 1 + delayMonths, 1)`. The first-due rule in the application (`firstDueMonthFromDisbursement`, 2026-10-03) is `new Date(year, month + delayMonths, 1)`: disbursement month plus the slot delay (early slot 1, slot 2 and late slot 2).
- The legacy ledger confirms the second formula: for 587 fresh loans disbursed 2024-2025 the first demand deduction landed `+1` month after the loan for day 1-5 (85 of 105), `+2` for day 6-24 (320 of 378) and `+2` for day 25-31 (94 of 104).
- All 6,967 stored schedule versions for real members (4,334 origination, 2,633 consolidation; 2,648 active loans) carried the later date.
- Side effect: 1,327 of the 1,613 payroll-lag (`is_payroll_lag_credit`) rows on origination cases are in the true first due month, i.e. they are the first normal EMI wrongly treated as the predecessor loan's payroll because the stored first due month was one month late.
- The legacy demand master has no demand rows for Dec-2023 or Jan-2024 for this member, in the live, backup and deleted-demand tables, so no short-recovery entry ever existed for those months; they show only as unpaid instalments of the corrected schedule.

**Formula.** Old: first due month = disbursement month + 1 + slot delay. New: first due month = disbursement month + slot delay (early slot +1, slot 2 +2, late slot +2).

**Code changed.**

- `src/scripts/phase2/bulk_ledger_replay.ts`: the first-due month now comes from `firstDueMonthFromDisbursement` (committed in v1.5.0, 2026-10-03, replacing the `+ 1 +` expression).
- Same file, new: a replayed repayment now carries its legacy voucher type; `D` (demand receipt) is written with `payment_source = 'DEMAND'`, everything else `'CASH'`. The skip branch for receipts already committed by an earlier run now (a) heals `payment_source`, and (b) un-flags a receipt an earlier run wrongly flagged as predecessor payroll and takes its principal off `loan_master.balance` again (the mirror of the existing reclassification to payroll).
- `src/modules/loan/services-v2/loan-repayment.service.ts`: the explicit-component insert used by the replay writes `payment_source`.
- Migration `1790726400000-AddLoanRepaymentPaymentSource` and `scripts/_backfill-loan-payment-source.ts`: added the column and tagged the existing migrated history (116,152 rows DEMAND where date and principal matched a `D` voucher in the ledger, 28,086 CASH).

**Dry run (member 610032487).** 1 member; schedule `EFFECTIVE_SCHEDULE case=17681 first_due_month=2023-12-01`; 2 flags, both the known zero-amount placeholder loans (case `3846` RLN and case `4805` ALN) which are not real loans. Log: `reports/phase2-610032487-first-due-fix-dryrun-20261003.log`.

**Live run.** Only member `610032487`, with `REPLAY_COMPLETED=true` (member was already `done`), `DRY_RUN=false`, `CONFIRM_LIVE_RUN=yes-i-mean-it`. Log: `reports/phase2-610032487-first-due-fix-live-20261003.log`. Backup taken first: `backups/pre-single-member-remigration-610032487-2026-10-03T17-40-45Z.dump` (94,165,668 bytes).

**Post-run checks (Postgres).**

- `loan_schedule_versions.first_due_month` for case `17681`: `2024-01-01` -> `2023-12-01`.
- The 26 existing receipts were skipped as already committed. One new receipt was added: 16-Sep-2026, a demand voucher that exists in the live legacy source but had not been copied yet (the legacy system is still being used, so the source moves). Result: 27 repayment rows, principal paid ₹27,000, `loan_master.balance` ₹23,000, 27 rows `DEMAND`, no payroll-lag rows.
- Early-closure quote (read-only): unpaid instalments are now Dec-2023 (#1, 34 months late, penalty ₹425), Jan-2024, May-2024, Jul-2024, Aug-2024, Sep-2024, Feb-2026 and Oct-2026; penalty ₹2,275; settlement ₹30,400. Outstanding principal ₹23,000 = ₹8,000 unpaid + 15 future instalments of ₹1,000.
- Not run: Phase 1 (ledger / demand-master copy) for this member, so the 16-Sep-2026 receipt is in the repayment history but not yet in the copied Postgres `ledger`. The Loan Position panel will show that ₹1,000 as a ledger-vs-record difference until Phase 1 is refreshed.

**Still open.**

1. The other 6,966 schedule versions still have the old first due month. Plan: a pinned-list dry run, then the live replay with `REPLAY_COMPLETED=true` (the corrected skip branch also repairs the 1,327 mis-flagged first EMIs), after a backup and review of all flags.
2. Loans without a schedule version (about 3,000 active) still use the older due-date formula in `getInstallmentStatus` (`disbursement + n + delay` months), which is also a month later than the real first due month. Decide whether to give them versions in the replay or change that fallback.
3. `MIGRATION_SOP.md` section 2a says payments before an origination's first due month are never predecessor payroll, while the replay applies the slot-delay exclusion at every boundary including origination; reconcile the two.

## 2026-10-03 (addendum): ledger refreshed for member `610032487`

The re-run above pulled a 16-Sep-2026 demand payment into `loan_repayment_ledger` that the Phase 1 copy of `ledger` did not have yet (the legacy system is still live). To bring the member's ledger level with the source without touching the loan records Phase 2 had just rebuilt, `migrate-single-member.js` gained an optional `--tables=<target tables>` argument (default behaviour unchanged: all 15 tables, delete-then-reinsert). Only `ledger` was refreshed:

```text
node scripts/legacy-migration/migrate-single-member.js 610032487 --tables=ledger            (dry run: would replace 314 rows with 319)
node scripts/legacy-migration/migrate-single-member.js 610032487 --tables=ledger --execute  (committed)
```

- Backup (taken by the execute run): `backups/pre-single-member-migration-610032487-2026-10-03T17-51-21-866Z.dump` (94,166,700 bytes).
- Result: 319 `ledger` rows copied and fingerprint-verified (SHA-256 match source vs target). The five new rows are the 16-Sep-2026 demand voucher `D00794` (loan principal ₹1,000, interest ₹275, plus the MD / CD / MD1 legs).
- Post-run check (read-only Loan Position): ledger balance ₹23,000 = loan-record balance ₹23,000, difference ₹0, ledger-paid ₹27,000 (all demand) = principal paid on the record, no notices; early-closure quote unchanged at ₹30,400.
- Not refreshed: `demand_master` for this member (legacy holds 51 rows, Postgres 50 — most likely the Sep-2026 demand). Refresh it the same way (`--tables=demand_master`) if wanted; do not copy `loan_master` or `member_balances` after Phase 2, because the copy would overwrite the replayed balances.

## 2026-10-03 (clean reset): member `610032487` deleted from Postgres and migrated again from the legacy source

**Decision.** All Postgres data is test data (the application is still in development), so the preferred way to correct a member is to delete that member's rows and migrate them again with the fixed scripts, not to patch rows in place. The earlier steps for this member (Phase 2 re-run on top of old rows, then a ledger-only refresh) were a patch; this entry replaces them with a clean migration, which is the procedure to repeat for other members.

**Procedure used (all steps scoped to one member).**

1. Backup: `backups/pre-single-member-reset-610032487-2026-10-03T18-09-32Z.dump` (94,171,377 bytes).
2. `node scripts/legacy-migration/delete-single-member.js 610032487 --execute`: deleted 561 rows across 20 tables (the script discovers member-scoped tables dynamically: 84 tables carry a member column, 20 held rows for this member).
3. `node scripts/legacy-migration/migrate-single-member.js 610032487 --execute` (Phase 1, all 15 tables; takes its own backup `backups/pre-single-member-migration-610032487-2026-10-03T18-10-24-267Z.dump`, 94,162,143 bytes): 516 rows copied and fingerprint-verified: `bank_cheq_master` 1, `demand_master` 51, `demand_masterdelete` 99, `frs` 1, `fundsmaster` 1, `ledger` 319, `ledger_data` 1, `loan_balance_history` 31, `loan_master` 3, `loan_masterhistory` 1, `loan_pending` 3, `loan_product` 2, `member_balances` 1, `member_master` 1, `membercategory` 1.
4. Phase 2: dry run, then live (`DRY_RUN=false CONFIRM_LIVE_RUN=yes-i-mean-it MBNO_FILTER=610032487 node scripts/legacy-migration/run-phase2.js`; `REPLAY_COMPLETED` is not needed because the batch-log row was deleted). 1 member, 27 repayments replayed, 0 consolidations, 2 flags (the zero-amount placeholder loans `3846` RLN and `4805` ALN, not real loans). Logs: `reports/phase2-610032487-fresh-dryrun-20261003.log`, `reports/phase2-610032487-fresh-live-20261003.log`.

**Which tables the member migration overwrites.** Phase 1 deletes and re-inserts the member's rows in the 15 tables above (so `loan_master`, `member_balances`, `demand_master`, `ledger` ... are replaced by legacy values). Phase 2 then writes `loan_repayment_ledger`, `loan_schedule_versions`, `legacy_replay_batch_log`, adjusts `loan_master.balance` / `delay_months` and reconciles the `member_balances` loan summary. `delete-single-member.js` removes the member from every table that has a member column, which includes tables that neither phase restores. For this member those were `share_monthly_balance` (1 row) and `yearend_member` (18 rows); the legacy source has no rows for this member in `YEAREND_MEMBER`, so they were application-generated and were not recreated. No other table held data for the member.

**Post-run checks (Postgres).**

- Case `17681`: 27 repayment rows, all `payment_source = 'DEMAND'`, principal paid ₹27,000, no payroll-lag rows, `loan_master.balance` ₹23,000, schedule `first_due_month` 2023-12-01, replay batch `done`, member loan summary 0.00 regular / 23,000.00 emergency.
- `ledger` 319 rows (includes the 16-Sep-2026 voucher `D00794`) and `demand_master` 51 rows (now includes the September 2026 demand).
- Read-only Loan Position: ledger ₹23,000 = loan record ₹23,000, difference ₹0, no notices.
- Read-only early-closure quote: unpaid instalments Dec-2023 (34 months, ₹425), Jan-2024, May-2024, Jul-2024, Aug-2024, Sep-2024, Feb-2026, Oct-2026; penalty ₹2,275; settlement ₹30,400. Identical to the patched result, now from a clean migration.

**Next.** The same three steps (delete, Phase 1, Phase 2) can be applied member by member or from a pinned list to correct the remaining migrated schedules, after a dry run of the list and a backup. The open items from the entry above still stand.

## 2026-10-04: member `610032274` had the same first-due-month fault; clean reset and re-migration

**Check (before).** Member `610032274`, ALN case `19560`: ₹50,000 / 24 months taken 20-Jun-2025 (slot 2 -> first EMI +2 months = Aug-2025). Stored `first_due_month` was 2025-09-01 (one month late), the first real EMI (demand voucher 14-Aug-2025) was therefore flagged as predecessor payroll (`is_payroll_lag_credit`) although this origination has no predecessor loan, `loan_master.balance` was ₹25,004 against ₹22,921 in the ledger (₹2,083 higher), the quote showed a phantom old-EMI deduction of ₹2,083 and 10 future instalments instead of 9, and the Loan Position panel showed a ledger-vs-record difference. The member paid every month Aug-2025 to Aug-2026, so no month was actually missed.

**Procedure.** Same as the 2026-10-03 clean reset: backup `backups/pre-single-member-reset-610032274-2026-10-03T18-29-18Z.dump` (94,173,486 bytes); `delete-single-member.js 610032274 --execute` (627 rows, 20 tables); `migrate-single-member.js 610032274 --execute` (Phase 1, 598 rows copied and verified); Phase 2 live for the one member (16 rows replayed incl. 2 zero-amount placeholders skipped, 14 repayments of case `19560`, flag only for the placeholder RLN case `3673`). Log: `reports/phase2-610032274-fresh-live-20261003.log`.

**After.** Schedule first due month 2025-08-01; 14 repayments (the legacy source now also holds the Sep-2026 EMI), all demand, none flagged as payroll lag; `loan_master.balance` ₹20,838 = ledger ₹20,838; no old-EMI deductions; 9 future instalments; only Oct-2026 (current month) unpaid, no penalty; closure quote ₹22,920 (was ₹25,529). Loan Position: difference ₹0, no notices.

**Pattern for the rest of the population.** A first EMI wrongly flagged as predecessor payroll because of the late first due month shows as: lag row on an origination case, balance on the record above the ledger by exactly one EMI, and a ledger-vs-record notice. Both faults disappear after the delete / Phase 1 / Phase 2 reset.

## 2026-10-04 - Bulk re-migration after the first-due-month fix

- Demand-only members: 1,003 deleted and migrated again (backup `backups/pre-first-due-reset-demand-only-2026-10-03T18-43-50Z.dump`); Phase 2: 56,082 repayments, 5,685 flags.
- Pilot of 30 members (backup `pre-first-due-reset-pilot30-2026-10-03T18-35-38Z.dump`): 1,346 repayments, 210 flags.
- Read-only trial run over 1,775 other members: 1,263 processed, 1,033 with blocking flags, 21 failed earlier, 512 have no receipts to replay.
- 227 other members with no blocking flag migrated again (backup `pre-first-due-reset-others-clean-2026-10-03T19-22-01Z.dump`, 122,399 rows deleted): 7,075 repayments, 252 flags (zero-amount placeholder loans only).
- Left untouched on purpose: members with blocking flags, failed earlier, or with nothing to replay; listed with reasons in docs/final-documentation/loan_slot_consolidation/Migration_Pattern_Register.xlsx (Manual worklist).

## 2026-10-06 - Repaid loan left open; ghost NR interest/penalty (member 610016033, case 11742)
- Fault: record balance kept at the "excluding predecessor payroll" figure (Rs 6,800) although ledger and replay had the loan fully repaid; closure engine netted the Rs 6,800 off principal but not off the schedule, so instalments 26-29 showed overdue (Rs 1,605.92 NR + Rs 4,462 penalty).
- Fixes: replay sets loan_master.balance = 0 for a case whose principal is fully recovered (`exhausted`); payments after that are flagged `Overpayment` (information, not a data exception); `getInstallmentStatus` counts the post-effective predecessor payroll principal toward "settled"; Loan Position shows overpaid-and-refunded (voucher P14119) from the ledger.
- Re-migrated 610016033 (backup `backups/pre-first-due-reset-fix-overpaid-2026-10-06T10-02-26Z.dump`): record balance 0, closure quote Rs 0, ledger = record.
- Other members need a re-migration for the replay part to take effect (1,058 accounts show record open / ledger closed).

---
## Pattern verification tracker (ONE section for all 12 patterns; update in place as each pattern is checked)
How a pattern is checked: take its ACTIVE loans (ledger still owes > Rs 100) and compare the loan record against the ledger (the ledger is a straight copy of the legacy ledger, so it is the truth). Differences are put into causes by `_cause_scan.py` / the Pattern tracker sheet of `docs/final-documentation/loan_slot_consolidation/Migration_Pattern_Register.xlsx` (the ONE Excel; never create another).
Causes: (1) old-EMI kept aside in the record - by design, record = ledger + old-EMI principal; (2) record closed / invalid legacy loan row but ledger owes; (3) no schedule built; (4) top-up/consolidation amounts differ; (5) journal entries; (6) other with a schedule.

### Baseline 2026-10-06 (after the first-due-month fix and the repaid-loan fix, before re-running members)
Active loans 2,151: 1,021 match, 320 by-design (old-EMI), 54 record closed, 446 no schedule, 60 top-up, 71 journal, 179 other.
| Pattern | Active | Match | By design | Rec. closed | No schedule | Top-up | Journal | Other |
|---|---|---|---|---|---|---|---|---|
| P01 Demand only | 771 | 300 | 163 | 8 | 123 | 34 | 30 | 113 |
| P02 Cash only | 49 | 13 | 8 | 1 | 10 | 2 | 5 | 10 |
| P03 Demand+cash same month | 29 | 6 | 4 | 1 | 10 | 3 | 0 | 5 |
| P04 Top-up while paying | 264 | 17 | 2 | 34 | 151 | 60 | 0 | 0 |
| P05 EMI keeps changing | 9 | 4 | 1 | 1 | 2 | 1 | 0 | 0 |
| P06 Cash lump sum | 137 | 47 | 11 | 5 | 56 | 5 | 6 | 7 |
| P07 Silent 12+ months | 1108 | 715 | 36 | 43 | 263 | 24 | 12 | 15 |
| P08 Journal entries | 326 | 108 | 29 | 16 | 80 | 22 | 71 | 0 |
| P09 Consolidated / old-EMI | 1050 | 191 | 279 | 15 | 300 | 46 | 67 | 152 |
| P10 Never paid | 535 | 450 | 0 | 27 | 58 | 0 | 0 | 0 |
| P11 Gap in demand payments | 473 | 200 | 59 | 14 | 118 | 28 | 30 | 24 |
| P12 Cash without interest | 92 | 34 | 8 | 1 | 26 | 7 | 9 | 7 |

Findings so far (per pattern entries are appended below as each is worked):
- Cause 2 (54 loans): the legacy loan master holds a negative or zero loan_amt row (e.g. -4,880) while the ledger still owes - nothing to replay, manual.
- Cause 6 (P01, 113): an older case keeps a stale balance after its last payment was capped (e.g. 30024580 case 13794, Rs 2,690) - same class as the repaid-loan fix (a case whose principal is used up must read 0); members re-migrated before that fix still carry it. Fix applied to the script 2026-10-06; re-running all previously re-migrated members (batch `refix-all`).

### Sample round 1 - 2026-10-06 (50 members, 70 active loans; testing method from now on)
Testing rule agreed with the user: re-migrate ONLY the fixed sample (`reports/sample50-members.txt`, active loans, ~4 members per pattern) after each fix and re-measure; the full migration is run once, when every pattern checks out.
Batch `sample50-r1` (backup `backups/pre-first-due-reset-sample50-r1-2026-10-06T11-27-45Z.dump`): 46 members replayed, 2,978 repayments, 532 flags.
Result on the 70 active loans: 18 match, 13 by design (old EMI kept aside), 9 record closed/ledger owes, 23 no schedule, 1 top-up, 5 journal, 1 other. Of the 39 real mismatches, 35 are on members whose replay raised "schedule not inferable"; ~20 also carry "payment before next loan was disbursed / no open case" and 7 "mixed RLN/ALN voucher".
Root-cause classes still open (each to be fixed and re-tested on the sample):
1. Schedule not inferable (first recurring principal not found) - fall back to the legacy loan terms, or manual.
2. Payment dated before the next loan is disbursed ("Unattributed CR ... next case") - the money belongs to the previous head/case; attribution walks heads separately.
3. Legacy loan_amt is cumulative (e.g. 610031282: record 2,110,000 vs ledger 410,000) - predecessor not closed without a journal pair.
4. Mixed RLN/ALN demand voucher: interest split unknown (data exception).
5. Zero/negative legacy loan rows with the ledger still owing (manual).
Interrupted-run note: the `refix-all` batch (1,247 members) hit a SQL Server outage for 806 members; their repayment history was restored with Phase 2 only (`reports/repair-phase2.log`, no errors). No full-population migration will be run until the sample is clean.

### Sample round 2-3 - 2026-10-06 (fixes for the five causes; invariants = ledger closing balance must match + every legacy ledger credit must be justified)
New read-only acceptance test: `_ledger_audit.js` (per member + loan head: closing balance record vs ledger; every credit matched to a replayed row, a consolidation close, or classed as overpayment; the rest listed as UNJUSTIFIED).
Fixes made in `bulk_ledger_replay.ts` (+ live `loan-repayment.service.ts`):
1. **Partial journal transfer no longer closes the loan.** A J credit smaller than what the case owes (an RLN<->ALN reclassification) is applied as a principal credit and the case stays open (610030031: a Rs 7,500 journal had closed a Rs 11 lakh loan and orphaned 38 payments).
2. **Credit before the next loan exists** (old EMI still on payroll after a cross-type consolidation) is applied to the next case as an earlier credit instead of being dropped.
3. **Ledger-first reconciliation** (`reconcileHeadToLedger`): after replay the loan records of a head must add up to the ledger closing balance. Newest loans take the debt first; an older open case the ledger no longer carries is closed ("superseded"); a head that owes with every case read as repaid reopens the newest real case; the loan amount/opening principal of the latest schedule version moves with it. Every adjustment is an INFO flag, never silent. Runs also for members that have nothing to replay.
4. **Record balance is net of old-loan EMI principal** (it is a real ledger credit): replay and the live `recordLoanRepayment` (explicit + auto-detected lag credits) now lower `loan_master.balance` by it, so record = ledger. The closure quote already netted it.
5. Earlier today: case whose principal is fully recovered is set to 0; overpayment after repaid is information, not an exception.
Result on the 50-member sample (70 active loan accounts): closing balance matches **69 of 70** (was 18 of 70). Credits not justified: 27 rows on 15 accounts (was 137 rows on 27 accounts).
Still open: (a) 610026925 ALN: ledger owes Rs 2,502 but the legacy source has no real loan row - manual. (b) The 27 credit rows: the replay marks a case exhausted/closed on loan_amt arithmetic (legacy loan_amt is cumulative, topups double-counted) while the ledger still owes, so later credits find no case (e.g. 610028194 RLN: 38 x Rs 1,098; 610029860 R 270,000/300,000). Next fix: decide "exhausted/closed" from the ledger head balance, not from loan_amt.

### Sample round 4-5 - 2026-10-06 (ledger-based "finished" + two silent-drop bugs)
Fixes in `bulk_ledger_replay.ts`:
1. **Finished is decided by the ledger, not by legacy loan_amt.** `buildOwedBefore` gives the ledger head balance at each credit's day. When every case reads "used up" on loan_amt arithmetic but the ledger still owes, the newest real case is reopened by what the ledger owes (INFO flag). A top-up with no open case reopens the newest real case on/before the date. "Exhausted" is now decided at the end of the walk. Replay rows (explicit principal) no longer hit the "already fully repaid" guard in `recordLoanRepayment`.
2. **TRANS_NO collision (silent drop).** The legacy ledger repeats TRANS_NO across vouchers of one member; consolidation CR legs were excluded from repayments by TRANS_NO alone, so an unrelated cash receipt sharing the number (610031733: ALN R40788 vs journal J09933, both 35) vanished with no flag. Now keyed by transNo + date + voucher.
3. The acceptance audit compares credits per DAY (a payment can be split over two cases), which showed most "unjustified" credits in round 3 were already justified.
Result on the 50-member sample (71 active accounts, batch `sample50-r5`): closing balance matches **70 of 71**; credits not justified **0**. The one open account is 610026925 ALN (ledger owes Rs 2,502, no real legacy loan row) - manual.
Review list produced by the script (INFO, never silent): 39 members had a loan record reconciled to the ledger (legacy loan amount/consolidation did not tie), 7 reopened by the ledger, 13 partial journal transfers, 14 credits before the next loan. Remaining blocking exceptions on the sample: schedule not inferable 35 members, mixed RLN/ALN voucher interest 11 (data exceptions; manual or a later rule).
Not yet done: full-population migration (waiting for your go-ahead); schedule-not-inferable fallback; interest-split rule for mixed vouchers.

### Sample round 6-8 - 2026-10-06 (schedule fallback from legacy loan terms)
Problem: the schedule (monthly principal EMI, term) was inferred only from the first recurring principal payment after the slot delay. Loans with no payment yet, or irregular ones, got no schedule (flag SCHEDULE_VERSION_NOT_BUILT) and fell back to the old date formula.
Fix: for the CURRENT agreement only (not superseded ones), and only for cases that start after 2018-11-30 (opening-balance cases have an instalment count whose start date the data does not hold), the schedule is taken from the legacy loan row: term = legacy no_of_instal, principal EMI = opening principal / term, interest = legacy instalment - principal; when the row holds principal only, interest is estimated as the reducing-balance average at the loan's rate (INFO flag says so). Every such schedule raises "INFO schedule from legacy loan terms ... please confirm the terms".
Result on the sample (`sample50-r8`): SCHEDULE_VERSION_NOT_BUILT flags 111 -> 26 (16 members); 85 schedules built from legacy terms (to confirm); closing balance 70/71 and 0 unjustified credits unchanged.
Still not buildable: opening-balance cases and superseded agreements without a recurring payment (manual or a later rule).

### Sample round 9-11 - 2026-10-06/07 (mixed RLN/ALN vouchers + interest invariant)
Added a third acceptance test, `_interest_audit.js`: every interest credit (I1002) in the ledger must be carried by replayed repayments, per member + day. Baseline on the sample: interest tied for 13 of 50 members (mixed vouchers, interest-only vouchers and dropped-principal days were missing about Rs 8 lakh).
Fixes in `bulk_ledger_replay.ts`:
1. **Mixed RLN/ALN vouchers** (one voucher, both loans' principal, one I1002 amount, no RLN-only baseline): the interest is split between the two loans in proportion to what the LEDGER owed on each just before the payment (both loans bill the same reducing-balance interest, so interest follows the debt); if both owe nothing, in proportion to the principal paid. The whole amount is always placed. INFO flag per member.
2. **Interest-only credits** (interest collected on its own, closure interest taken when a new loan consolidates the old one, interest on a day whose principal found no case): per day, whatever part of the I1002 credits the attributed repayments did not carry is replayed as an interest-only repayment row on the case closed that day, else the newest disbursed case; between RLN and ALN by ledger-owed proportion. INFO flag.
Result on the sample (`sample50-r11`): interest ties for **50 of 50** members; closing balance 70/71; 0 unjustified credits.
Caveat: the split between RLN and ALN is a rule, not a legacy figure (none exists); it only moves interest between a member's two loans, never changes totals.

### Opening balance rule - 2026-10-07 (found while checking member 610025676)
Fault: the opening balance of a member's loan head was SUM(loan_master.openbalance) over all cases. Legacy repeats the carried-forward balance on every year-end case, so the same debt was counted two or more times (610025676: RLN 1,30,000 counted as 2,60,000, ALN 1,45,000 as 2,90,000 - both loans are fully repaid in the legacy ledger). This inflated the Member Ledger opening, the Loan Position panel, the closure-window "ledger shows repaid" tag, my active-loan counts and the ledger-first reconciliation (it had forced records up to the doubled figure).
Rule (one definition, `src/modules/loan/loan-opening-balance.ts`, copied into `_pattern_scan.js` and `_ledger_audit.js`): per loan type, take the cases that carry an openbalance and are dated BEFORE the first ledger entry of that head; the latest-dated of them (several on one date are added) is the opening; none = 0. Evidence on all migrated data: 459 loan accounts where it differs from adding all cases; 283 then close at exactly 0 (against 1 when added).
Applied in: Member Ledger (`member-ledger.service.ts`), Loan Position (`loan-position.service.ts`), member loans list (`loan-query.service.ts`), replay (`bulk_ledger_replay.ts`: owed-before and reconcile), scan and audit scripts.
Sample re-run `sample50-r12`: active loan accounts 71 -> 48 (23 were wrongly "active"); closing balance matches 47 of 48 (610026925 ALN manual); 0 unjustified credits; interest ties 50/50. 610025676: RLN 0 and ALN 0 (was 1,30,000 and 1,45,000).
Open: 6 head accounts close slightly negative (overpayments/refunds: 610031768, 610032733, 610030182 x2, 610019662, 610027176) - to review; members outside the sample keep their old (inflated) record balances until re-migrated.

### Standing rule: known ledger faults - notice + flag + manual correction register (2026-10-07)
User decision: whenever a ledger problem like the following is found, always do the same three things: (1) show a notice in the Loan Position panel, (2) flag the member for manual correction (Excel "Manual corrections" sheet + replay flag MANUAL_CORRECTION_APPLIED), (3) record the fix in `backend/scripts/legacy-migration/manual-corrections.json` so it is RE-APPLIED on every re-migration (full run included). The migrated ledger rows are never changed (the Member Ledger keeps matching legacy); only loan records / repayment history take the correction. Code: `src/scripts/phase2/manual-corrections.ts` (events retyped before attribution; owed-before and ledger closing adjusted); `_ledger_audit.js` honours the file.
New notices (loan-position.service.ts): POSSIBLE_WRONG_LOAN_TYPE (a loan account is in credit while the member's other loan account owes), OVERPAID_NOT_REFUNDED (money taken after the loan was repaid, no refund in the ledger), MANUAL_CORRECTION (shown on the corrected loan).
The six negative accounts (checked 2026-10-07): wrong loan type - 610027176 (J21708, Rs 17,000 credited to emergency, loan is regular) and 610031768 (D00515, Rs 750 credited to regular, loan is emergency): both listed in manual-corrections.json and corrected (re-migrated, batch `corrections`: 610027176 regular loan now Rs 0 and settled; 610031768 emergency loan reduced by Rs 750; audits tie). Overpayments not refunded (notice only, no correction): 610032733 RLN Rs 1,200, 610030182 RLN Rs 4,600 + ALN Rs 1,667, 610019662 RLN Rs 2,000.

### Clean check of the 50-member sample - 2026-10-07 (batch `sample50-r13`, `_sample_final_check.js`)
Checked member by member against the legacy SQL Server (read-only). Results: ledger rows legacy vs new identical for all 50 (count and debit/credit totals per loan type); loan master openbalance identical (a higher loan amount on receiving cases is expected); every credit and every interest credit justified (0 gaps); no loan that is repaid in the ledger is still open (0); closing balance legacy ledger (opening counted once, manual corrections applied) vs loan record matches on 46 of 47 active loan accounts (610026925 emergency: ledger owes Rs 2,502, no real legacy loan row - manual).
Verdicts: CLEAN 1, TO CONFIRM 24 (all checks pass, but a figure came from a rule: schedule built from legacy loan terms, record reconciled to the ledger, or reopened by the ledger), FLAGGED - MANUAL 25 (schedule not built 16, open loan without schedule 5, credit balance 4, manual correction 2, topup/close with no case 3, balance differs 1, ledger owes with no loan row 1).
Note: 90 reconciliation adjustments on 40 members (median Rs 65,130; 59 set an older case to 0 because the ledger no longer carries it): the replay's own case attribution still disagrees with the ledger for most members with several cases; the outcome matches the ledger by construction and is listed as TO CONFIRM.

### Ledger-driven rebuild - 2026-10-07 (batches `sample50-r14` .. `r17`, 50-member sample)
Decision (user): the consolidated amount on the ledger is the truth for the new loan; do not re-check or rebuild old loans' history; track only the new loan's principal, interest, repayments and NR from the consolidation on; do not use a duplicate / stale legacy loan row.
New engine `buildLedgerAttribution` (bulk_ledger_replay.ts) replaces the loan_amt / PL_BALANCE / top-up arithmetic:
1. One current loan per loan head. A disbursal day starts a new loan; its principal = the ledger head balance right after that day's debits (older balance carried in); the older open loan ends that day (consolidation event generated from the ledger). `loan_master.loan_amt/balance` are set to that ledger principal (legacy loan_amt is cumulative/stale: 610030031 ALN 16979 is Rs 2,60,000, not Rs 2,67,500 - the Rs 7,500 journal cancels three earlier overpayments).
2. Credits go to the current loan until the ledger balance reaches 0; a credit above the balance is an overpayment (no row); a debit that only repays an earlier credit balance is a refund (not a top-up).
3. Top-ups into a running loan create a new schedule boundary from the ledger balance after it; with no new EMI visible yet the previous EMI continues (INFO).
4. Duplicate legacy rows (same member, loan type, day, amount; 36 groups / 34 members in the data): the one whose own terms (loan amount / instalments) explain the payments is kept, the others are ignored and set to 0 (610028303: case 16097 20 x Rs 10,000 real, 16098 80 x Rs 2,500 duplicate).
5. Old EMI still deducted after a consolidation (610030031 regular loan: Rs 6,087 x 3 months after the new loan, then Rs 10,204): payments equal to the predecessor's EMI that all come before a different recurring principal are NOT the new loan's EMI; the new EMI is that later principal (Rs 10,204; term = ledger principal / EMI = 98) and the early months are short recovery that the due-status code penalises. A legacy loan row that still carries the OLD EMI is never used as the fallback.
6. Members with only debits (never paid) are now in the replay scope; opening balance rule from the ledger.
7. The ledger tie-out is a safety net only now: `LEDGER_MISMATCH_AFTER_REPLAY` is reported and never forced (FORCE_RECONCILE=1 restores forcing). Stored balances are net of old-EMI principal; reconcile no longer subtracts it again.
Result on the sample (47 active loan accounts): closing balance ties by itself on 44 of 47 (no forcing); every credit justified; ledger rows identical; no repaid loan still open. Verdicts: CLEAN 29, TO CONFIRM 6, FLAGGED - MANUAL 15 (the check now counts schedule flags only for loans that are still open). Examples: 610030031 regular loan Rs 10,00,000 / Rs 10,204 / 98 instalments; emergency Rs 2,60,000 / 3,250 / 80 and Rs 3,00,000 / 3,750 / 80; record balances = ledger (5,97,574 and 2,41,000).
Open: 610032800 ALN (24 cases, balance Rs 3,000 off, interest days), 610019662 ALN (debit after overpayment), 610026925 (no loan row), interest not tied on 610031282 / 610032800 / 610019495, 5 open loans without any schedule, 4 credit balances (notice), 2 manual corrections. Old functions buildAttribution / findPvoucherConsolidations are now unused. Regular-loan interest of 610030031 comes from the fixed RLN-only baseline (Rs 3,591, the old loan's) - to confirm.

### Open cases - 2026-10-07 (batches `sample50-r18` .. `r20`)
Fixes: (1) the loan record balance is now set from the ledger-driven walk after each case replays (`finalRemainingPrincipal`), so a top-up or refund after the last replayed payment is in the record (610019662 emergency loan Rs 2,000, 610032800 emergency loan Rs 3,000 off); (2) interest-only credits are placed only on live loans (not an ignored duplicate row / carried case) and split equally when neither loan owed anything that day (interest of 610031282, 610032800, 610019495 now ties).
Result on the 50-member sample: closing balance ties on 46 of 47 active loan accounts without any forcing; every credit justified; every interest credit carried (50 of 50); ledger rows identical to legacy; no repaid loan still open. Verdicts: CLEAN 30, TO CONFIRM 6, FLAGGED - MANUAL 14.
The 14 flagged: 4 members with a credit balance (overpayment not refunded, notice only: 610032412, 610032733, 610030182, 610019662); 2 deliberate manual corrections (610031768, 610027176); 5 members with a carried-forward loan that has no payment in the ledger window, so no EMI can be known (610030685, 610031752, 610017203, 610019495, 610026925 - the last also has no legacy loan row for Rs 2,502); 3 members whose open loan has an agreement window with only one payment to infer an EMI from (130030327, 610032344, 610032800).

### Scope error found - 2026-10-07 (member number range) and active loan count in MSSQL
My scripts treated every member number >= 900,000,000 as a test member. That is wrong: 1,387 REAL legacy members have 9-digit numbers starting with 9 (900,017,674 .. 990,042,373; 1,032 of them have loans, 704 have loan-ledger rows). Test members are 900,000,001..900,016,999 (7 in Postgres) and >= 9,000,000,000 (SLOTTEST / SLOTMATRIX / synthetic, 70). Effect: the 50-member sample, every audit, the pattern scan and the Excel counts (1,856 / 1,906 active loans) left these members out, and delete-members-from-list.js would have refused them. Fixed in delete-members-from-list.js, _pattern_scan.js, _build_reset_list.js (real = < 900,000,000 or 900,017,000 .. 8,999,999,999). Their Postgres data is still the original Sep-20 migration (never re-migrated).
Active loans in the legacy MSSQL (ledger closing balance > Rs 100, opening balance counted once): 2,335 loan accounts over 2,116 members = 1,441 emergency (ALN) + 894 regular (RLN); 219 members hold both; 471 accounts are in credit (< -100). The legacy tables' own figures are unusable: LOAN_MASTER BALANCE > 0 on 12,556 rows (stale), Member_Balances regular > 0 on 1,718 and emergency > 0 on 1,519.

### Clean-loan migration - 2026-10-07 (all active loans; batch `active-clean`)
Master list: every active loan account of the legacy MSSQL = 2,335 accounts / 2,116 members (reports/active-loans-mssql.psv; sheet "Active loans" in Migration_Pattern_Register_current.xlsx, with the verdict before migration, migrated or not, and the result after).
Verdict before migration comes from a read-only dry run of the replay over all 2,116 members (`dryrun-active-all.log`, `_classify_active.js`), per member: CLEAN 790 members / 907 accounts; TO CONFIRM 285 / 336 (a figure came from a rule); MANUAL 1,041 / 1,092 (no ledger entries at all 515 accounts, credit balance 276, schedule not built for an open loan 238, open loan without any schedule 162, ledger owes with no loan row 84, ...).
Migrated: the 790 CLEAN members (backup `backups/pre-first-due-reset-active-clean-2026-10-07T10-10-21Z.dump`; 529,878 rows deleted, 47,452 repayments replayed, no errors). Checked against the legacy MSSQL with `_ledger_audit.js`, `_interest_audit.js`, `_active_final_check.js`.
First pass: 903 of 907 accounts PERFECT, 4 PROBLEM. Two causes found and fixed: (1) legacy has a third loan type ELN (10 rows) - an emergency loan on the ALN head - that the replay never loaded (members 610026986, 610032450, 990040951); (2) a legacy placeholder row with a NEGATIVE loan amount kept its negative balance in the record (940021418). Replay now loads ELN as the emergency head (loan_master keeps type ELN) and zeroes the balance of invalid rows. The 4 members were re-migrated and re-checked: PERFECT.
Result: 907 of 907 clean accounts PERFECT. "Perfect" means: legacy ledger rows identical, loan master opening balances identical, closing balance (opening once) = loan record, every credit and interest credit accounted for, every open loan has a schedule, no repaid loan still open. It does NOT yet prove the schedules / EMI / penalty / closure amounts are right (checked by hand only on the 50-member sample and 610030031).
Note: members with ELN loans were classified before the ELN fix; 6 of them are outside the clean list and need a fresh dry run.

### Outcome sanity test - 2026-10-07 (`src/scripts/_outcome_sanity.ts`)
A loan can pass every data check and still give a result nobody should accept unseen (610028678: principal Rs 52,336, early-closure amount Rs 1,34,129). For every open loan of a member list the test runs the real early-closure calculation and marks the loan REVIEW when any rule fires: closure > 1.5 x principal; 6+ instalments behind; 12+ months without a payment; no payment since the loan began; penalty larger than the unpaid principal (thresholds via SANITY_RATIO / SANITY_BEHIND / SANITY_SILENT_MONTHS). Output reports/outcome-sanity-<label>.json, shown in the "Active loans" sheet (columns Outcome sanity test .. Sanity reasons) and counted in "Active loans summary".
Run on the 790 migrated clean members (913 open loans): OK 669, REVIEW 244 (closure > 1.5 x principal 164, 6+ instalments behind 151, 12+ months silent 103, penalty > principal 24; a loan can have several).
