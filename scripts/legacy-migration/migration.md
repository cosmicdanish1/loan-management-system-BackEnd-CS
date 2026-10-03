# Legacy loan migration — incident and replay notes

**Last updated:** 2026-09-25  
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
