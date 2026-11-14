# Phase 2 (loan replay) issue register

One place for every difference found while checking migrated members against the old program. Companion Excel: `reports/Phase2_Issues_Register.xlsx` (sheets: Issues, Candidates, Members checked). Keep both in step: add the row in Excel and the entry here.

Script: `src/scripts/phase2/bulk_ledger_replay.ts` (run by `run-phase2.js`; one member by `migrate-member.js <mbno> [--execute]`).
Rule of work: reproduce first, classify as **migration (Phase 2)**, **application** or **legacy data**, fix only the right layer, re-migrate only the named member, let the user check, then widen.

## How Phase 2 works (the stages, so an issue can be pinned to one)
1. **Read**: the member's legacy `LOAN_MASTER` rows and ledger entries of the loan heads (`A1002` regular, `A1047` emergency) and the matching interest entries.
2. **Ledger attribution** (`buildLedgerAttribution`): decides which loan each ledger entry belongs to, the **opening principal of every loan** (the ledger balance of the loan head on its disbursal day) and where one loan is consolidated into the next.
3. **Schedule versions** (`loan_schedule_versions`): opening principal, fixed monthly principal, interest, number of instalments, slot delay, per start or consolidation.
4. **Replay**: every repayment goes through the app's own `recordLoanRepayment` (principal and interest split, payroll-lag detection).
5. **Write**: `loan_master` (`loan_amt`, `balance`, instalments), `loan_repayment_ledger`, `member_balances` loan columns.
6. **Reconcile**: the loan balances are compared with the ledger.

## Issues

### P2-001: new consolidated loan shows a loan amount ₹6,250 too high (121 instead of 120 instalments)
- **Found:** 2026-11-14, member **610031839**, regular loan case **17959** (Loan Early Closure screen showed loan amount ₹10,06,250 and 121 instalments).
- **Layer:** **migration, Phase 2 stage 2 (ledger attribution)**. The application only displays what is stored (`loan_master.loan_amt`, schedule version 1).
- **Legacy facts:** on 15-Jan-2024 the regular-loan head went 4,56,250 -> disbursement R49749 (DR 5,50,000) -> journal **J26313** (CR regular loan 6,250 / DR emergency loan 6,250) = **₹10,00,000** after the day. 10,00,000 over 120 instalments of 8,334 fits.
- **Cause:** the day was processed as "debits first, then credits". The opening principal was the balance after the debits only (₹10,06,250). The journal credit of the same day was replayed as a repayment of the new loan and then excluded from the schedule as "slot-delay payroll", so it never reduced the opening principal. Result: `loan_amt` 10,06,250, term 121, and a false "₹12,500 principal still owed back" warning.
- **Fix (2026-11-14):** in `buildLedgerAttribution`, on a disbursal day, a matched two-leg journal that credits the same loan head the same day (a transfer to the other loan head) is taken out of the carried older balance and netted into the opening principal; it is not replayed as a repayment. A flag `INFO JOURNAL_TRANSFER_OUT_AT_DISBURSAL` is written for every use.
- **Verified for 610031839 (re-migrated, only this member):** `loan_amt` 10,06,250 -> **10,00,000**; instalments 121 -> **120**; schedule v1 opening principal 10,06,250 -> **10,00,000**; carried older balance 4,56,250 -> **4,50,000**; EMI 13,542 and balance **7,27,062 unchanged** (ledger-true). The Feb-2024 payroll ₹8,844 is still flagged as old-loan payroll (separate point P2-002).
- **Other members:** **re-migrated 2026-11-14** (17 members, Phase 1 + Phase 2, no failed member). The fix was used for 16 of the 17 (flag `JOURNAL_TRANSFER_OUT_AT_DISBURSAL`); for 610031087 no loan starts that day, so nothing changed. After the run the loan amount equals the ledger balance after that day for the checked cases (round figures such as ₹3,00,000, ₹2,00,000, ₹5,00,000). Pattern: The fix applies to **19 events for 18 members** (a clean two-leg journal, regular loan credit and emergency loan debit or the reverse, of the same amount, on a disbursal day of the credited head): 610022961, 610024111, 610028515, 610029765, 610030060 (twice), 610030983, 610031045, 610031087, 610031838, 610031839, 610031904, 610032478, 610032481, 610032662, 610033022, 610033146, 610033172, 940029743. List: `reports/p2-001-affected-members.txt`; details in the Excel sheet `Candidates`. They change when Phase 2 is next run for them.
- **Status:** FIXED in the script, applied to all 18 members, waiting for the user's check on screen.

### P2-002: payroll deducted for the old loan after the consolidation is shown as "owed back to the member" (to confirm)
- **Seen on:** 610031839 case 17959 (Early Closure screen: "Old-loan payroll was still deducted after this loan started", Feb 2024 ₹6,250 principal + ₹2,594 interest, box ticked).
- **What it is:** a business rule of the app (payroll-lag): the first old-EMI amount inside the slot-delay window after a consolidation is treated as the old loan's deduction, kept out of the new schedule and offered back to the member. Phase 2 arms it (`PAYROLL_LAG_ARMED`).
- **Open question for the user:** is the Feb-2024 deduction really to be returned to the member, or is it a normal repayment of the new loan in the old program? Not changed.
- **Status:** TO CONFIRM.

### P2-003: ledger regular-loan balance with no regular loan record (940029743), legacy data, manual
- **Seen:** 2026-11-14 in the re-migration of 940029743: `LEDGER_OWES_NO_OPEN_CASE (RLN)` and `LEDGER_MISMATCH_AFTER_REPLAY`, ledger ₹4,15,000, loan records ₹0.
- **Cause:** journal on 2026-06-09 moved ₹4,55,000 from the emergency loan head to the regular loan head and the legacy loan master has no regular loan row for it. Not caused by P2-001 (the regular-loan loop is unchanged for this member).
- **Status:** OPEN, manual review (existing flag type).

### P2-004: replay refused on days marked closed (Day-End done), 38 members failed (test DB), plan impact for production
- **Seen:** 2026-11-14, parallel re-migration of the 2,509 active-loan members: 38 members failed with "The day 2026-08-NN is already closed (Day-End has been done). Nothing can be posted on a closed day." (dates 14-24 Aug 2026).
- **Layer:** application rule (ES-458, `assertPostingDateOpen`, called inside `recordLoanRepayment`) meeting the test database, where `getworkingdate` has 11 closed test days (14-24 Aug 2026). A legacy repayment dated on such a day is refused.
- **Handled for the test DB (2026-11-14):** the 11 day-end flags were opened for about 2 minutes, the 38 members were re-run (38 done, 0 failed), and the flags were restored exactly (checked identical). Nothing else was touched.
- **PLAN IMPACT (production run sheet, section 44 of migration-v1.md):** `getworkingdate` is loaded with about 2,357 closed days (legacy). If it is loaded BEFORE Phase 2, nearly every replayed repayment is refused. **Phase 2 must run before `getworkingdate` (and any closed financial year) is loaded**, or the guard must be lifted for the replay. Recorded as correction 44.7.
- **Status:** test DB DONE; production rule recorded.

## Run log
- **2026-11-14 re-migration of the 2,509 active-loan members** (list `reports/active-loan-members.txt`): loan_master reset from legacy (Phase 1, loan_master only, 0 flagged), old replay output cleared, parallel Phase 2 with 4 workers: 1,942 done in 18 min, 38 failed (P2-004), re-run: 38 done. **Total 1,980 done, 0 failed.** The other 529 members of the list have no regular- or emergency-loan entries in the ledger (loans only in the legacy loan master, for example opening loans), so Phase 2 does not replay them; their loan records stay as copied from legacy. Both Phase 2 copies carry the P2-001 fix.

## Member status workbook (for the client hand-over)
`reports/Member_Migration_Status_2026-11-14.xlsx` (regenerate after every re-run). Sheets: **Summary**; **Members** (every member of the sheet Legacy_Members_And_Loans: category and what the client or team must do); **Head balance check** (legacy ledger balance per member and loan head against Postgres and against the user's sheet; opening balance by the app rule in `loan-opening-balance.ts`); **Loan balance check** (loan by loan against the user's sheet); **Flags** (every replay flag).
Result on 2026-11-14 after the re-migration: Postgres equals the legacy ledger on 2,731 of 2,871 member loan heads (95.1%) and differs on 140 (category 6 INVESTIGATE, and category 5 MANUAL for the members the replay blocked). The user's sheet equals the ledger on 1,052 (37%), so most differences against the sheet come from the sheet's own rule (to be confirmed in the old application on a few members).

## Template for a new issue
`ID | date | member | loan case | where seen (screen/value) | expected (old program / ledger) | layer (migration / application / legacy data) | cause | fix and file | members affected | status | verified how`

## Members checked
Kept in the Excel sheet `Members checked`: member, date, loan cases looked at, result (match / issue ID), who checked.
