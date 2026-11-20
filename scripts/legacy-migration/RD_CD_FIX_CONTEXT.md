# RD / CD fix and migration run: context for other sessions (2026-11-19)

## Why
In the legacy MS SQL system RD and CD are ONE deposit (head `L1004` COMPULSORY DEPOSIT; `demand_master.RD_Amount` is 0 in all 334,033 rows; the RD tables are empty; `member_balances.RD_Amt` is the MONTHLY amount, equal to `fundsmaster.cdamt` for 97% of members). The new app also books RD to `L1004`, but kept a second store (`rd_balance_events`, `rd_installment_ledger`) that nothing filled for migrated members, so every migrated member showed RD = 0. Also `member_balances.compulsory_deposit` (and shares, FRS) was a copy of the 2019 snapshot, correct for only about 900 of 7,265 members.

## What was fixed (Jira: ES-563 under epic ES-515; status Testing)

### Application (backend, uncommitted; backend restart needed; not tested live)
1. `rd-balance-events.service.ts` `getTotalCurrentHoldings`: RD holdings = `member_balances.compulsory_deposit` (one figure; negative counts as 0 because Group Insurance negatives are cleared from the next loan payout). Used by loan eligibility, the lien, the withdrawal limit and the early-closure RD adjustment.
2. `recordWithdrawal` (same file): lowers that same balance under the member lock, never below zero; no longer fails when the interest timeline does not cover the amount (migrated members have no timeline). Before, RD applied at early closure posted `L1004` DR but never lowered the stored balance.
3. `balance.service.ts` and `member-balance.service.ts`: the Member Balance screens no longer add `rd_amt` (monthly amount) on top of the CD balance; RD and CD are one line.
4. `ledger-posting.service.ts` `postMemberDeposits`: monthly payroll posting credits each MEMBER's own heads like the legacy voucher (checked on legacy voucher D00306): RD+CD to `L1004`, MD to `L1002`, share to `L1001`, one CR line per member with the member number, one DR `A1001` (member 0) per head, and raises `member_balances.compulsory_deposit` / `frsbalance` / `shares` in the same transaction. Before: one lump on `L1001` with member 0, no member credited. Loan principal/interest lines unchanged (still `A1003` / `L1028` lumps).
5. `data-consistency.service.ts`: new "RD / CD Balance Check" (stored balance vs `fundsmaster.cdopbal` + net `L1004`), warning level.
6. Unit tests updated/added: `tests/unit/rd/rd-balance-closing.spec.ts`, `tests/unit/member/member-balance.service.spec.ts`, `tests/unit/utility/live-tables.spec.ts` and `data-maintenance.service.spec.ts`, `tests/unit/transaction/ledger-posting.service.spec.ts` and `voucher-ledger-posting.spec.ts`. RD, loan, utility, member and transaction suites pass; unrelated failures seen: `updateLoanSanction` (loan), `saveMemberMaster` (member), `SystemHealthMonitoringService` (utility).

### Migration (scripts in backend/scripts/legacy-migration)
7. `derive-cd-balance.js` (new, last step of the run): `compulsory_deposit` = `cdopbal` + net `L1004`; `shares` = `shareopbal` + net `L1001`; `frsbalance` = (`mdopbal` + net `L1002`) + (`md1_opbal` + net `L1045`) (decisions Q37 and Q38 in migration-v1.md section 19). Writes only these columns; creates the missing `member_balances` rows in the minimal shape the app inserts (about 720); re-checks every member against an independent query and rolls back on any difference. First read-only count: 6,439 balances to correct, 722 rows to create, 18 already right; totals CD/RD 24.61 crore, shares 4.24 crore, FRS 5.43 crore (these tie to the plan's section 19 figures).
8. `fundsmaster`: only legacy rows missing in Postgres are copied (never overwritten), so Modify Balance edits are not touched.
9. Run order (`run-all-2.js`, in the Claude session scratchpad): Phase 1 for all members without `fundsmaster` / `member_balances` -> missing `fundsmaster` rows -> clear Phase 2 output -> Phase 2 -> `derive-cd-balance.js --execute`.
10. `migrate-rd-from-cd.js` (RD interest timeline openings) was written but is NOT part of the run: RD interest is to be handled when the RD module is worked on.
11. `migration-v1.md` sections 47 and 47.1 record the finding and decisions.

### Earlier in the same session (Phase 2 and tooling)
12. ES-552: phantom overdue and penalty for loans dated before the ledger start (2019-11-01) fixed in `src/scripts/phase2/bulk_ledger_replay.ts` (Testing).
13. ES-553: closure interest taken at a consolidation was split onto the wrong loan type; whole credit now goes to the loan type closed that day (Testing).
14. `migrate-all-members.js`: `EXCLUDE_TABLES` option (used to leave `fundsmaster` and `member_balances` alone).
15. `live-progress.js`: read-only per-member progress watcher (DONE/FAILED per member).
16. Read-only finding (no code): undocumented EMI changes (re-agreement without a record) are detectable only as candidates from `demand_master`; about 250 members; ES-554 (Excel 35,000 vs ledger 30,000) still open.

## Still open (decisions or work not done)
- Loan lines of the payroll posting still use `A1003` / `L1028` lumps with member 0 and cash on `A1001`; legacy used per-member `A1002` / `A1047` / `I1002` and bank head `A1008` mode B.
- RD interest and RD financial-year closing still read the (empty for migrated members) timeline tables.
- The standalone RD withdraw endpoint posts no ledger entry (already so before).
- Nothing is committed; the user commits from their own git chat. Backend restart needed.
- Do not touch Dividend Report / Warrant / Paid (owner's rule).
