# Paper White Technology - LMS API — API Reference

Version 1.0. Auto-generated from Swagger metadata — do not edit by hand; run `npm run openapi:generate`.

- **Server root:** `http://<server-ip>:3001` — every path below already includes the `/api/v1` prefix.
- **Auth:** `Authorization: Bearer <accessToken>` (from `POST /auth/login`).
- **Total endpoints:** 388 across 54 groups.

## Groups

- [admin](#admin) (6)
- [Admin - Cast Categories](#admin-cast-categories) (5)
- [Admin - Designations](#admin-designations) (5)
- [Admin - Member Balances](#admin-member-balances) (2)
- [Admin - Member Funds (Migration)](#admin-member-funds-migration-) (3)
- [Admin - Member Management](#admin-member-management) (2)
- [Admin - Office Master](#admin-office-master) (5)
- [Admin - Passbook Templates](#admin-passbook-templates) (6)
- [Admin - SB Account](#admin-sb-account) (5)
- [Admin - Wing Master](#admin-wing-master) (5)
- [Administration](#administration) (7)
- [Application](#application) (2)
- [Authentication](#authentication) (7)
- [Backup & Restore](#backup-restore) (5)
- [cashbook](#cashbook) (6)
- [Client Logs](#client-logs) (1)
- [Compulsory Deposit Transactions](#compulsory-deposit-transactions) (3)
- [consolidation](#consolidation) (1)
- [Dashboard Notices](#dashboard-notices) (4)
- [Database Backup](#database-backup) (6)
- [Day-End Processing](#day-end-processing) (6)
- [daybook](#daybook) (6)
- [Deposits](#deposits) (19)
- [Dividend - Calculation](#dividend-calculation) (2)
- [Dividend - Credit](#dividend-credit) (2)
- [Dividend - Share Monthly Balance](#dividend-share-monthly-balance) (3)
- [Financial Year Management](#financial-year-management) (6)
- [general-ledger](#general-ledger) (2)
- [Interest Management](#interest-management) (7)
- [jotting-report](#jotting-report) (4)
- [Journal Transfer Transactions](#journal-transfer-transactions) (1)
- [license](#license) (3)
- [Loans](#loans) (29)
- [member-ledger](#member-ledger) (4)
- [Members](#members) (19)
- [notifications](#notifications) (4)
- [print-voucher](#print-voucher) (4)
- [RD - Balance Events](#rd-balance-events) (3)
- [RD - Counter Repayment](#rd-counter-repayment) (2)
- [RD - Financial Year Closing](#rd-financial-year-closing) (5)
- [RD - Interest Calculation](#rd-interest-calculation) (1)
- [RD - Member Config](#rd-member-config) (3)
- [RD - Payment Pattern Eligibility](#rd-payment-pattern-eligibility) (1)
- [Reports](#reports) (52)
- [Reports - Demand List](#reports-demand-list) (1)
- [Role Management](#role-management) (4)
- [Search](#search) (2)
- [System Configuration](#system-configuration) (18)
- [Transaction - Demand Generation](#transaction-demand-generation) (3)
- [Transaction - Ledger Posting](#transaction-ledger-posting) (2)
- [Transaction - Short Recovery](#transaction-short-recovery) (2)
- [Transactions](#transactions) (9)
- [User Management](#user-management) (14)
- [Utilities](#utilities) (59)

## admin

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/admin/certificate-templates` | _no description_ |
| `POST` | `/api/v1/admin/certificate-templates` | _no description_ |
| `DELETE` | `/api/v1/admin/certificate-templates/{id}` | _no description_ |
| `GET` | `/api/v1/admin/certificate-templates/{id}` | _no description_ |
| `PUT` | `/api/v1/admin/certificate-templates/{id}` | _no description_ |
| `GET` | `/api/v1/admin/certificate-templates/default` | _no description_ |

## Admin - Cast Categories

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/admin/cast-categories` | Get all caste categories |
| `POST` | `/api/v1/admin/cast-categories` | Create a new caste category |
| `DELETE` | `/api/v1/admin/cast-categories/{id}` | Delete a caste category |
| `GET` | `/api/v1/admin/cast-categories/{id}` | Get a caste category by ID |
| `PATCH` | `/api/v1/admin/cast-categories/{id}` | Update a caste category |

## Admin - Designations

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/admin/designations` | Get all designations |
| `POST` | `/api/v1/admin/designations` | Create a new designation |
| `DELETE` | `/api/v1/admin/designations/{code}` | Delete a designation |
| `GET` | `/api/v1/admin/designations/{code}` | Get a designation by code |
| `PATCH` | `/api/v1/admin/designations/{code}` | Update a designation |

## Admin - Member Balances

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/admin/member-balances/{memberNo}` | Get member balance by Member No |
| `PATCH` | `/api/v1/admin/member-balances/{memberNo}` | Update member balance |

## Admin - Member Funds (Migration)

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/admin/member-funds/{memberNo}` | Get member detailed balances |
| `PATCH` | `/api/v1/admin/member-funds/{memberNo}` | Update member detailed balances |
| `GET` | `/api/v1/admin/member-funds/list` | Get ordered list of all member numbers in fundsmaster for navigation |

## Admin - Member Management

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/admin/members/{memberNo}` | Get member details by ID |
| `POST` | `/api/v1/admin/members/transfer` | Transfer member to a new office |

## Admin - Office Master

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/admin/offices` | Get all offices |
| `POST` | `/api/v1/admin/offices` | Create a new office |
| `DELETE` | `/api/v1/admin/offices/{id}` | Delete an office |
| `GET` | `/api/v1/admin/offices/{id}` | Get an office by ID |
| `PATCH` | `/api/v1/admin/offices/{id}` | Update an office |

## Admin - Passbook Templates

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/admin/passbook-templates` | Get all passbook templates |
| `POST` | `/api/v1/admin/passbook-templates` | Create a new passbook template |
| `DELETE` | `/api/v1/admin/passbook-templates/{id}` | Delete a passbook template |
| `GET` | `/api/v1/admin/passbook-templates/{id}` | Get passbook template by ID |
| `PUT` | `/api/v1/admin/passbook-templates/{id}` | Update an existing passbook template |
| `GET` | `/api/v1/admin/passbook-templates/default` | Get default passbook template by account type |

## Admin - SB Account

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/admin/sb-accounts` | Get all SB Accounts |
| `POST` | `/api/v1/admin/sb-accounts` | Create a new SB Account |
| `DELETE` | `/api/v1/admin/sb-accounts/{id}` | Delete an SB Account |
| `GET` | `/api/v1/admin/sb-accounts/{id}` | Get an SB Account by ID |
| `PATCH` | `/api/v1/admin/sb-accounts/{id}` | Update an SB Account |

## Admin - Wing Master

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/admin/wings` | Get all wings |
| `POST` | `/api/v1/admin/wings` | Create a new wing |
| `DELETE` | `/api/v1/admin/wings/{id}` | Delete a wing |
| `GET` | `/api/v1/admin/wings/{id}` | Get a wing by ID |
| `PATCH` | `/api/v1/admin/wings/{id}` | Update a wing |

## Administration

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/admin/dashboard` | Get admin dashboard data |
| `GET` | `/api/v1/admin/deposit-loan-slabs` | Get all deposit/loan slabs |
| `POST` | `/api/v1/admin/deposit-loan-slabs` | Create new deposit/loan slab |
| `DELETE` | `/api/v1/admin/deposit-loan-slabs/{id}` | Delete deposit/loan slab |
| `GET` | `/api/v1/admin/deposit-loan-slabs/{id}` | Get deposit/loan slab by ID |
| `PATCH` | `/api/v1/admin/deposit-loan-slabs/{id}` | Update deposit/loan slab |
| `GET` | `/api/v1/admin/system-info` | Get system information |

## Application

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/` | Get application information |
| `GET` | `/api/v1/health` | Health check endpoint |

## Authentication

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/auth/change-password` | Change user password |
| `POST` | `/api/v1/auth/login` | User login |
| `POST` | `/api/v1/auth/logout` | User logout |
| `GET` | `/api/v1/auth/me` | Get current user profile |
| `POST` | `/api/v1/auth/refresh` | Refresh access token |
| `POST` | `/api/v1/auth/register` | Register new user (Admin only) |
| `GET` | `/api/v1/auth/users-list` | Get list of all users for dropdown (authenticated admins only) |

## Backup & Restore

| Method | Path | What it does |
| --- | --- | --- |
| `DELETE` | `/api/v1/admin/backup/{filename}` | Delete backup file |
| `POST` | `/api/v1/admin/backup/create` | Create database backup |
| `GET` | `/api/v1/admin/backup/list` | List all available backups |
| `POST` | `/api/v1/admin/backup/restore` | Restore database from backup |
| `GET` | `/api/v1/admin/backup/verify/{filename}` | Verify backup integrity |

## cashbook

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/cashbook/interest-rate` | _no description_ |
| `GET` | `/api/v1/cashbook/member/balance` | _no description_ |
| `GET` | `/api/v1/cashbook/members/active` | _no description_ |
| `GET` | `/api/v1/cashbook/report` | _no description_ |
| `POST` | `/api/v1/cashbook/transaction` | _no description_ |
| `GET` | `/api/v1/cashbook/transactions` | _no description_ |

## Client Logs

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/client-logs` | Ingest a batch of client-side (desktop app) log entries |

## Compulsory Deposit Transactions

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/transactions/cd/income-heads` | Get Income Ledger heads from main table |
| `GET` | `/api/v1/transactions/cd/members` | Get list of members for CD transaction matrix |
| `POST` | `/api/v1/transactions/cd/post` | Execute bulk CD interest/incentive posting |

## consolidation

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/consolidation/report` | _no description_ |

## Dashboard Notices

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/dashboard-notices` | List all dashboard notices, shared across every PC |
| `POST` | `/api/v1/dashboard-notices` | Post a new dashboard notice |
| `DELETE` | `/api/v1/dashboard-notices/{id}` | Delete a dashboard notice |
| `PUT` | `/api/v1/dashboard-notices/reorder` | Persist a new drag-and-drop order for the board |

## Database Backup

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/backup/cleanup` | Clean up old backups based on retention policy |
| `POST` | `/api/v1/backup/create` | Create database backup |
| `GET` | `/api/v1/backup/database-info` | Get database configuration information |
| `GET` | `/api/v1/backup/list` | Get list of existing backups |
| `GET` | `/api/v1/backup/test-connection` | Test database connection |
| `POST` | `/api/v1/backup/validate-destination` | Validate backup destination path |

## Day-End Processing

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/admin/day-end/initiate` | Initiate day-end processing |
| `GET` | `/api/v1/admin/day-end/processes` | Get all day-end processes |
| `GET` | `/api/v1/admin/day-end/processes/{id}` | Get day-end process by ID |
| `GET` | `/api/v1/admin/day-end/processes/{id}/interest-calculations` | Get interest calculation results for a day-end process |
| `GET` | `/api/v1/admin/day-end/processes/{id}/summary` | Get day-end process summary |
| `GET` | `/api/v1/admin/day-end/summary` | Get current day-end summary |

## daybook

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/daybook/active-members` | _no description_ |
| `POST` | `/api/v1/daybook/calculate-interest` | _no description_ |
| `GET` | `/api/v1/daybook/interest-rate` | _no description_ |
| `POST` | `/api/v1/daybook/pay-interest` | _no description_ |
| `GET` | `/api/v1/daybook/report` | _no description_ |
| `GET` | `/api/v1/daybook/report/sb` | _no description_ |

## Deposits

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/deposits/calculate-interest` | Calculate and post interest for all deposits |
| `GET` | `/api/v1/deposits/certificates/download/{fileName}` | Download certificate file |
| `GET` | `/api/v1/deposits/fixed-deposits` | Get all fixed deposits |
| `POST` | `/api/v1/deposits/fixed-deposits` | Create a new fixed deposit |
| `GET` | `/api/v1/deposits/fixed-deposits/{id}` | Get fixed deposit by ID |
| `PUT` | `/api/v1/deposits/fixed-deposits/{id}` | Update fixed deposit |
| `POST` | `/api/v1/deposits/fixed-deposits/{id}/certificate` | Generate fixed deposit certificate |
| `PATCH` | `/api/v1/deposits/fixed-deposits/{id}/close` | Close fixed deposit |
| `PATCH` | `/api/v1/deposits/fixed-deposits/{id}/maturity` | Process fixed deposit maturity |
| `GET` | `/api/v1/deposits/member/{memberNo}` | Get deposits by member Number (e.g. M-001) |
| `GET` | `/api/v1/deposits/members/{memberId}/fixed-deposits` | Get fixed deposits by member ID |
| `GET` | `/api/v1/deposits/members/{memberId}/recurring-deposits` | Get recurring deposits by member ID |
| `POST` | `/api/v1/deposits/members/{memberId}/share-certificate` | Generate share certificate for member |
| `PATCH` | `/api/v1/deposits/rd-installments/{id}/pay` | Pay RD installment |
| `GET` | `/api/v1/deposits/recurring-deposits` | Get all recurring deposits |
| `POST` | `/api/v1/deposits/recurring-deposits` | Create a new recurring deposit |
| `GET` | `/api/v1/deposits/recurring-deposits/{id}` | Get recurring deposit by ID |
| `POST` | `/api/v1/deposits/recurring-deposits/{id}/certificate` | Generate recurring deposit certificate |
| `PATCH` | `/api/v1/deposits/recurring-deposits/{id}/close` | Close recurring deposit |

## Dividend - Calculation

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/dividend/calculation/commit` | Commits the dividend calculation for a financial year into dividend_master — does NOT credit Share Value |
| `GET` | `/api/v1/dividend/calculation/preview` | Read-only preview of the Total Product dividend calculation for a financial year — writes nothing |

## Dividend - Credit

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/dividend/credit/commit` | Credits every member's eligible prior-year dividend into their Share Value |
| `GET` | `/api/v1/dividend/credit/preview` | Read-only preview of the prior financial year's dividend that would be credited to Share Value at this year's close — writes nothing |

## Dividend - Share Monthly Balance

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/dividend/share-snapshot` | Capture a month-end Share Capital balance snapshot for every member holding shares |
| `GET` | `/api/v1/dividend/share-snapshot/history/{mbno}` | A member's full Share Capital monthly balance history |
| `GET` | `/api/v1/dividend/share-snapshot/report` | The captured Share Capital balance snapshot for a given month/year |

## Financial Year Management

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/admin/financial-year/balance-transfer` | Perform manual balance transfer between accounts |
| `POST` | `/api/v1/admin/financial-year/close-year` | Formally close (lock) a financial year |
| `GET` | `/api/v1/admin/financial-year/current` | Get current active financial year |
| `GET` | `/api/v1/admin/financial-year/list` | Get all financial years |
| `POST` | `/api/v1/admin/financial-year/pl-year-end-process` | Initiate P&L Year End Process |
| `POST` | `/api/v1/admin/financial-year/transfer-entries` | Initiate transfer entries for year closing |

## general-ledger

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/general-ledger/head-masters` | Get all head masters for dropdown |
| `GET` | `/api/v1/general-ledger/report` | Generate general ledger report |

## Interest Management

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/interest/current-rate` | Get current interest rate for savings accounts |
| `GET` | `/api/v1/interest/history` | Get interest calculation history |
| `POST` | `/api/v1/interest/preview-calculation` | Preview interest calculation without saving to database |
| `POST` | `/api/v1/interest/preview-yearly-fund` | Preview yearly fund (Interest, Dividend, Insurance) calculation |
| `POST` | `/api/v1/interest/process-yearly-fund` | Process yearly fund calculation and post to ledger |
| `POST` | `/api/v1/interest/update-saving-interest` | Calculate and update saving interest for all eligible members |
| `POST` | `/api/v1/interest/validate-parameters` | Validate interest calculation parameters |

## jotting-report

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/jotting-report` | _no description_ |
| `GET` | `/api/v1/jotting-report/head-masters` | _no description_ |
| `GET` | `/api/v1/jotting-report/offices` | _no description_ |
| `GET` | `/api/v1/jotting-report/wings` | _no description_ |

## Journal Transfer Transactions

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/transactions/journal/post` | Post a multi-row balanced journal entry |

## license

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/license/activate` | _no description_ |
| `GET` | `/api/v1/license/list` | _no description_ |
| `GET` | `/api/v1/license/status` | _no description_ |

## Loans

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/loans/amortization-schedule` | Generate amortization schedule |
| `POST` | `/api/v1/loans/calculate-emi` | Calculate EMI for given parameters |
| `GET` | `/api/v1/loans/case/{caseNo}` | Get loan details by case number |
| `GET` | `/api/v1/loans/case/{caseNo}/repayment-summary` | Repayment totals (paid/principal/interest/penal) for one loan case |
| `GET` | `/api/v1/loans/cases` | Get all loan cases for processing |
| `GET` | `/api/v1/loans/due-status/{caseNo}` | What a loan currently owes, oldest-unpaid-first, including tiered penal |
| `POST` | `/api/v1/loans/early-closure/execute/{caseNo}` | Actually settle a loan early -- writes ledger entries and zeroes the balance |
| `POST` | `/api/v1/loans/early-closure/quote/{caseNo}` | Read-only early-closure quote using the true reducing-balance schedule |
| `GET` | `/api/v1/loans/generate/loan-case-number` | Generate next sequential loan case number |
| `POST` | `/api/v1/loans/loan-application` | Save a new loan application |
| `GET` | `/api/v1/loans/master/{caseNo}` | Get loan from loan_master (active loans) |
| `GET` | `/api/v1/loans/master/{caseNo}/emi-schedule` | Get EMI schedule for loan from loan_master with payment status |
| `GET` | `/api/v1/loans/member/{mbno}/repayment-history` | Full repayment ledger history for a member, across all their loans |
| `GET` | `/api/v1/loans/member/{memberNo}/all` | Get all loans for a member from loan_pending |
| `GET` | `/api/v1/loans/member/{memberNo}/cases` | Get loan cases for a specific member |
| `GET` | `/api/v1/loans/member/{memberNo}/master` | Get all active loans for a member from loan_master |
| `GET` | `/api/v1/loans/member/{memberNo}/pending` | Get pending loans for a specific member |
| `GET` | `/api/v1/loans/member/{memberNo}/surety-cases` | Get all loan cases for a member (pending + active) for surety change form |
| `GET` | `/api/v1/loans/month-end/history/{mbno}` | A member's full month-end loan balance history |
| `GET` | `/api/v1/loans/month-end/report` | The captured month-end loan balance snapshot for a given month/year |
| `POST` | `/api/v1/loans/month-end/snapshot` | Capture a month-end loan balance snapshot for every member with an active loan |
| `GET` | `/api/v1/loans/pending/{caseNo}` | Get loan from loan_pending (pending loans) |
| `POST` | `/api/v1/loans/repayment` | Record a repayment against a loan, oldest-unpaid installment first |
| `PATCH` | `/api/v1/loans/sanction/{caseNo}` | Update loan with sanction details |
| `GET` | `/api/v1/loans/sanctioned` | Get all sanctioned loan cases ready for disbursement |
| `GET` | `/api/v1/loans/search/member-loans` | Search loans across loan_master and loan_pending |
| `GET` | `/api/v1/loans/surety/{caseNo}` | Get current sureties for a loan case |
| `PATCH` | `/api/v1/loans/surety/{caseNo}` | Change loan sureties (guarantors) |
| `GET` | `/api/v1/loans/surety/validate/{memberNo}` | Validate if a member can be a surety |

## member-ledger

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/member-ledger/detail-report` | _no description_ |
| `GET` | `/api/v1/member-ledger/head-masters` | _no description_ |
| `GET` | `/api/v1/member-ledger/report` | _no description_ |
| `GET` | `/api/v1/member-ledger/validate-member` | _no description_ |

## Members

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/members` | Get all members with pagination |
| `POST` | `/api/v1/members` | Create a new member |
| `DELETE` | `/api/v1/members/{id}` | Delete member |
| `GET` | `/api/v1/members/{id}` | Get member by ID |
| `PATCH` | `/api/v1/members/{id}` | Update member |
| `DELETE` | `/api/v1/members/{id}/signature` | Delete member signature |
| `GET` | `/api/v1/members/{id}/signature` | Get member signature image |
| `POST` | `/api/v1/members/{id}/signature` | Upload member signature |
| `GET` | `/api/v1/members/balance/{memberNo}` | Get comprehensive member balance |
| `GET` | `/api/v1/members/balance/{memberNo}/quick` | Get quick balance summary |
| `GET` | `/api/v1/members/details/{memberNo}` | Get member details by member number |
| `GET` | `/api/v1/members/find/{memberNo}` | Find member by member number |
| `GET` | `/api/v1/members/generate/member-number` | Generate next sequential member number |
| `GET` | `/api/v1/members/lookup` | Lookup members for forms and dropdowns |
| `DELETE` | `/api/v1/members/master/{mbno}/signature` | Delete signature for legacy member_master member |
| `GET` | `/api/v1/members/master/{mbno}/signature` | Get signature image for legacy member_master member |
| `POST` | `/api/v1/members/master/{mbno}/signature` | Upload signature for legacy member_master member |
| `POST` | `/api/v1/members/save-member` | Save member to legacy member_master table |
| `GET` | `/api/v1/members/statistics` | Get member statistics |

## notifications

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/notifications/history` | _no description_ |
| `POST` | `/api/v1/notifications/send-manual` | _no description_ |
| `GET` | `/api/v1/notifications/stats` | _no description_ |
| `POST` | `/api/v1/notifications/trigger-emi-check` | _no description_ |

## print-voucher

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/print-voucher/{voucherNo}` | _no description_ |
| `GET` | `/api/v1/print-voucher/journal/{voucherNo}` | _no description_ |
| `GET` | `/api/v1/print-voucher/journal/list/all` | _no description_ |
| `GET` | `/api/v1/print-voucher/list/all` | _no description_ |

## RD - Balance Events

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/rd/balance/{mbno}/{yearcode}/current` | A member's current RD balance for a financial year |
| `GET` | `/api/v1/rd/balance/{mbno}/{yearcode}/timeline` | A member's full RD balance-event timeline for a financial year |
| `POST` | `/api/v1/rd/balance/{mbno}/{yearcode}/withdraw` | Withdraw from a member's RD balance, enforcing the configured minimum |

## RD - Counter Repayment

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/rd/repayment/{mbno}/{yearcode}` | Record a member's RD payment for one specific month at the counter — amount used exactly as entered |
| `GET` | `/api/v1/rd/repayment/{mbno}/{yearcode}/pending` | A member's 12 RD months for the financial year, with each one's current payment status |

## RD - Financial Year Closing

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/rd/closing/{mbno}/{yearcode}/close` | Close one member's RD financial year — credits interest, writes the audit summary, rolls the balance forward |
| `GET` | `/api/v1/rd/closing/{mbno}/{yearcode}/preview` | One member's read-only closing preview |
| `POST` | `/api/v1/rd/closing/{yearcode}/close-all` | Close every member with RD activity this year in one batch — failures are collected, not fatal to the batch |
| `GET` | `/api/v1/rd/closing/{yearcode}/members` | Every member with RD activity in a financial year (candidates for closing) |
| `GET` | `/api/v1/rd/closing/{yearcode}/preview` | Bulk read-only preview of what closing this year would produce, for the review screen |

## RD - Interest Calculation

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/rd/interest/{mbno}/{yearcode}/preview` | Preview a member's RD installment + opening-balance interest for a financial year |

## RD - Member Config

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/rd/member-config/{mbno}/{yearcode}` | Set a member's monthly RD amount for a financial year |
| `GET` | `/api/v1/rd/member-config/{mbno}/{yearcode}/current` | The member's currently-effective monthly RD amount for a financial year |
| `GET` | `/api/v1/rd/member-config/{mbno}/{yearcode}/history` | A member's monthly RD amount change history for a financial year |

## RD - Payment Pattern Eligibility

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/rd/pattern/{mbno}/{yearcode}` | Preview a member's RD payment-pattern eligibility for a financial year |

## Reports

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/reports/account-closing` | Get account closing register |
| `GET` | `/api/v1/reports/adhoc-reports` | Get AdHoc reports |
| `GET` | `/api/v1/reports/annual-member-statement` | Get annual member statement |
| `GET` | `/api/v1/reports/balance-sheet` | Get Balance Sheet |
| `POST` | `/api/v1/reports/bank/ledger` | Get bank detail ledger |
| `GET` | `/api/v1/reports/banks` | Get list of bank accounts |
| `POST` | `/api/v1/reports/cashbook/daily` | Get daily cash book report (voucher-wise) |
| `POST` | `/api/v1/reports/cashbook/monthly` | Get monthly cash book summary |
| `POST` | `/api/v1/reports/cashbook2/daily` | Get daily cash book report (head-wise from tblcashbook) |
| `POST` | `/api/v1/reports/defaulters` | Get defaulter list |
| `POST` | `/api/v1/reports/deposit/maturity` | Get deposit maturity report |
| `GET` | `/api/v1/reports/diagnostic` | Run diagnostic check |
| `GET` | `/api/v1/reports/dividend-paid` | Get dividend paid report |
| `GET` | `/api/v1/reports/dividend-report` | Get dividend report |
| `GET` | `/api/v1/reports/dividend-warrant` | Get dividend warrant |
| `GET` | `/api/v1/reports/divisions` | Get division list |
| `GET` | `/api/v1/reports/financial-summary` | Get financial summary (Trial Balance) |
| `GET` | `/api/v1/reports/heads` | Get list of account heads |
| `POST` | `/api/v1/reports/interest-certificate` | Get interest certificate |
| `GET` | `/api/v1/reports/interest-list` | Get interest list |
| `POST` | `/api/v1/reports/jotting` | Get jotting report |
| `POST` | `/api/v1/reports/ledger/detail` | Get detail ledger for a head code |
| `GET` | `/api/v1/reports/lien-account-information` | Get lien account information |
| `GET` | `/api/v1/reports/loan-contributions-register` | Get loan contributions register |
| `GET` | `/api/v1/reports/loan-nil-certificate/{memberNo}` | Get loan nil certificate |
| `GET` | `/api/v1/reports/loan-types` | Get loan types |
| `POST` | `/api/v1/reports/loans/interest-statement` | Get interest receivable/received statement |
| `POST` | `/api/v1/reports/loans/new-disbursed` | Get newly disbursed loans |
| `GET` | `/api/v1/reports/member-balance-range` | Get members by account number range |
| `GET` | `/api/v1/reports/member-ledger` | Get member ledger |
| `GET` | `/api/v1/reports/member-loan-detail` | Get member loan detail report |
| `GET` | `/api/v1/reports/member/{memberNo}/loan-cases` | Get loan cases for a member |
| `POST` | `/api/v1/reports/member/balance-range` | Get members by balance range |
| `POST` | `/api/v1/reports/member/loan-ledger` | Get member loan ledger |
| `GET` | `/api/v1/reports/member/profile/{memberNo}` | Get member profile |
| `POST` | `/api/v1/reports/member/statement` | Get member statement |
| `GET` | `/api/v1/reports/offices` | Get office list |
| `GET` | `/api/v1/reports/passbook-printing` | Get passbook printing data |
| `POST` | `/api/v1/reports/rd/statement` | Get RD statement |
| `GET` | `/api/v1/reports/recovery-details` | Get recovery details |
| `GET` | `/api/v1/reports/recurring-details` | Get recurring details |
| `POST` | `/api/v1/reports/saving/statement` | Get saving statement |
| `GET` | `/api/v1/reports/schedule` | Get all report schedules |
| `POST` | `/api/v1/reports/schedule` | Create or update report schedule |
| `GET` | `/api/v1/reports/schedule/{id}` | Get report schedule details |
| `POST` | `/api/v1/reports/schedule/execute` | Execute report schedule |
| `GET` | `/api/v1/reports/share-certificate` | Get share certificate |
| `GET` | `/api/v1/reports/share-warrant` | Get share warrant |
| `GET` | `/api/v1/reports/surety-register` | Get surety register |
| `GET` | `/api/v1/reports/voters-list` | Get voters list |
| `GET` | `/api/v1/reports/wings` | Get wing list |
| `GET` | `/api/v1/reports/yearly-member-statement` | Get yearly member statement |

## Reports - Demand List

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/transactions/reports/demand-list/generate` | Generate detailed Members Demand List |

## Role Management

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/admin/roles/defaults` | Update default rights for a user level |
| `GET` | `/api/v1/admin/roles/defaults/{levelId}` | Get default rights for a user level |
| `GET` | `/api/v1/admin/roles/levels` | Get all user levels |
| `GET` | `/api/v1/admin/roles/menus` | Get all menu items |

## Search

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/search/global` | Global search across all data types |
| `GET` | `/api/v1/search/suggestions` | Get search suggestions |

## System Configuration

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/admin/config/business-rules` | Get all business rules in a flat structure |
| `POST` | `/api/v1/admin/config/business-rules/bulk` | Update multiple business rules at once |
| `GET` | `/api/v1/admin/config/deposit-slabs` | Get all deposit slabs |
| `POST` | `/api/v1/admin/config/deposit-slabs` | Create deposit slab |
| `DELETE` | `/api/v1/admin/config/deposit-slabs/{id}` | Delete deposit slab |
| `GET` | `/api/v1/admin/config/deposit-slabs/{id}` | Get deposit slab by ID |
| `PUT` | `/api/v1/admin/config/deposit-slabs/{id}` | Update deposit slab |
| `GET` | `/api/v1/admin/config/interest-rates` | Get all interest rates |
| `POST` | `/api/v1/admin/config/interest-rates` | Create interest rate |
| `DELETE` | `/api/v1/admin/config/interest-rates/{id}` | Delete interest rate |
| `GET` | `/api/v1/admin/config/interest-rates/{id}` | Get interest rate by ID |
| `PUT` | `/api/v1/admin/config/interest-rates/{id}` | Update interest rate |
| `GET` | `/api/v1/admin/config/system` | Get all system configurations |
| `POST` | `/api/v1/admin/config/system` | Create system configuration |
| `DELETE` | `/api/v1/admin/config/system/{id}` | Delete system configuration |
| `PUT` | `/api/v1/admin/config/system/{id}` | Update system configuration |
| `POST` | `/api/v1/admin/config/system/initialize` | Initialize default system configurations |
| `GET` | `/api/v1/admin/config/system/key/{key}` | Get system configuration by key |

## Transaction - Demand Generation

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/transactions/demand-generation/generate` | Generate demand specifically for a period |
| `POST` | `/api/v1/transactions/demand-generation/import-preview` | Preview demand list import from a real uploaded Excel/CSV file |
| `POST` | `/api/v1/transactions/demand-generation/import-process` | Save previously-previewed demand import rows for the selected month/year |

## Transaction - Ledger Posting

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/transactions/ledger-posting/post` | Post updates to General Ledger |
| `GET` | `/api/v1/transactions/ledger-posting/summary` | Get ledger posting summary for a period |

## Transaction - Short Recovery

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/transactions/short-recovery` | Get all short recoveries |
| `POST` | `/api/v1/transactions/short-recovery/adjust` | Adjust a short recovery |

## Transactions

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/v1/transactions/dividend/pay` | Process dividend payment |
| `GET` | `/api/v1/transactions/dividend/pending/{memberNo}` | Get pending dividends for a member |
| `POST` | `/api/v1/transactions/loan-voucher` | Generate a loan disbursement voucher |
| `POST` | `/api/v1/transactions/pass/{voucherNo}` | Pass transaction - final posting to ledger and cashbook |
| `POST` | `/api/v1/transactions/reverse/{voucherNo}` | Reverse a posted transaction |
| `POST` | `/api/v1/transactions/voucher` | Create a generic voucher (Payment/Receipt/Journal) |
| `DELETE` | `/api/v1/transactions/voucher/{voucherNo}` | Delete/Reject a pending voucher |
| `GET` | `/api/v1/transactions/voucher/{voucherNo}` | Get voucher details by number |
| `GET` | `/api/v1/transactions/vouchers/pending` | Get all pending vouchers |

## User Management

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/admin/users` | Get all users with pagination and filtering |
| `POST` | `/api/v1/admin/users` | Create a new user |
| `DELETE` | `/api/v1/admin/users/{id}` | Delete user |
| `GET` | `/api/v1/admin/users/{id}` | Get user by ID |
| `PUT` | `/api/v1/admin/users/{id}` | Update user information |
| `GET` | `/api/v1/admin/users/{id}/activities` | Get user activities |
| `POST` | `/api/v1/admin/users/{id}/activities` | Log user activity |
| `PUT` | `/api/v1/admin/users/{id}/password` | Change user password (admin) |
| `PUT` | `/api/v1/admin/users/{id}/role` | Update user role and permissions |
| `GET` | `/api/v1/admin/users/active-sessions/matrix` | Get all active user sessions |
| `POST` | `/api/v1/admin/users/active-sessions/terminate` | Force logout a user session (Admin) |
| `GET` | `/api/v1/admin/users/activities` | Get all user activities |
| `PUT` | `/api/v1/admin/users/change-password` | Change own password |
| `GET` | `/api/v1/admin/users/roles/permissions` | Get role permissions mapping |

## Utilities

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/v1/utilities` | _no description_ |
| `POST` | `/api/v1/utilities/balance-transfer` | Process a manual balance transfer between accounts |
| `GET` | `/api/v1/utilities/balance/account/{accountType}/{accountId}` | Get account balance |
| `GET` | `/api/v1/utilities/balance/member/{memberId}` | Get member balance inquiry |
| `GET` | `/api/v1/utilities/balance/member/{memberId}/accounts` | Get all account balances for a member |
| `GET` | `/api/v1/utilities/balance/member/{memberId}/realtime` | Get real-time member balance |
| `GET` | `/api/v1/utilities/business-rules` | Get current business rules from busrules table |
| `POST` | `/api/v1/utilities/business-rules` | Save business rules to busrules table |
| `GET` | `/api/v1/utilities/calculator/loan-rates` | Get current loan interest rates from business rules |
| `GET` | `/api/v1/utilities/calculator/member-eligibility` | Check loan eligibility for a member |
| `GET` | `/api/v1/utilities/data-consistency/check` | Run comprehensive data consistency checks |
| `POST` | `/api/v1/utilities/data-correction/auto-fix` | Auto-fix consistency issues |
| `POST` | `/api/v1/utilities/data-correction/balance-discrepancies` | Correct balance discrepancies |
| `POST` | `/api/v1/utilities/data-correction/fix-integrity` | Fix data integrity issues |
| `POST` | `/api/v1/utilities/data-correction/orphaned-records` | Fix orphaned records |
| `POST` | `/api/v1/utilities/data-correction/recalculate-balances` | Recalculate all balances |
| `POST` | `/api/v1/utilities/data-correction/remove-duplicates` | Remove duplicate records |
| `GET` | `/api/v1/utilities/demand-print-order` | Get demand print order configuration |
| `POST` | `/api/v1/utilities/demand-print-order` | Save demand print order configuration |
| `GET` | `/api/v1/utilities/deposit-loan-slabs` | Get deposit/loan interest slabs from fdrd_slab_details |
| `POST` | `/api/v1/utilities/deposit-loan-slabs` | Save deposit/loan interest slabs to fdrd_slab_details |
| `POST` | `/api/v1/utilities/dividend/pay` | Process dividend payment — DR L1024, update dividend_master |
| `GET` | `/api/v1/utilities/dividend/pending` | Get pending dividends for a member |
| `GET` | `/api/v1/utilities/divisions` | Get all divisions from division_master |
| `GET` | `/api/v1/utilities/fd-accounts/member` | Get active FD accounts for a member |
| `POST` | `/api/v1/utilities/fd-interest/post` | Post FD interest voucher — CR A003/FD, vchr_type=J |
| `GET` | `/api/v1/utilities/fd-rd-sb/accounts` | Get FD/RD/SB accounts for a member |
| `POST` | `/api/v1/utilities/fd-rd-sb/entry` | Save FD/RD/SB ledger entry |
| `POST` | `/api/v1/utilities/fd-receipt` | Create FD receipt — inserts into fdmaster + ledger (CR A003/FD) |
| `GET` | `/api/v1/utilities/financial-year/current` | Get the current (latest) financial year |
| `POST` | `/api/v1/utilities/financial-year/transfer-entries` | Transfer entries for financial year closing |
| `GET` | `/api/v1/utilities/head-master` | Get all account heads from headmaster with balance sheet data |
| `POST` | `/api/v1/utilities/head-master` | Add or update an account head in headmaster |
| `GET` | `/api/v1/utilities/health/alerts` | Get active health alerts |
| `POST` | `/api/v1/utilities/health/alerts/{alertId}/resolve` | Resolve a health alert |
| `GET` | `/api/v1/utilities/health/alerts/all` | Get all health alerts |
| `GET` | `/api/v1/utilities/health/diagnostics` | Run comprehensive system diagnostics |
| `GET` | `/api/v1/utilities/health/history` | Get system health history |
| `GET` | `/api/v1/utilities/health/performance` | Get performance metrics |
| `GET` | `/api/v1/utilities/health/status` | Get current system health status |
| `POST` | `/api/v1/utilities/loan/entry` | Save loan entry to loan_master and suretymaster |
| `GET` | `/api/v1/utilities/member/balance` | Get member balance information |
| `POST` | `/api/v1/utilities/payment-voucher` | Save payment voucher to ledger (vchr_type=P, acc_type=BANK) |
| `GET` | `/api/v1/utilities/preferences` | Get current user UI preferences |
| `PATCH` | `/api/v1/utilities/preferences` | Update user UI preferences |
| `POST` | `/api/v1/utilities/receipt` | Save receipt: CR rows (vchr_type=R) + DR bank (vchr_type=P), same R_VCHR_NO |
| `POST` | `/api/v1/utilities/receipt-voucher` | Save receipt voucher to ledger (vchr_type=R, DR CINH + CR rows) |
| `GET` | `/api/v1/utilities/saving/account/{accountNo}` | Get saving account details and transaction history |
| `POST` | `/api/v1/utilities/saving/transaction` | Save SB transaction to ledger (acc_type=SB) |
| `GET` | `/api/v1/utilities/search/deposits` | Search for deposit accounts (RD/FD) by member number |
| `GET` | `/api/v1/utilities/search/global` | Global search across all entities |
| `GET` | `/api/v1/utilities/search/loans` | Search loan accounts with filters |
| `GET` | `/api/v1/utilities/search/members` | Search members with filters |
| `GET` | `/api/v1/utilities/search/sb-accounts` | Search for savings bank accounts by member number |
| `GET` | `/api/v1/utilities/search/transactions` | Search transactions with filters |
| `POST` | `/api/v1/utilities/statement/generate` | Generate account statement |
| `GET` | `/api/v1/utilities/statement/member/{memberId}` | Generate member statement for date range |
| `GET` | `/api/v1/utilities/system-settings/{key}` | Get global system setting |
| `PATCH` | `/api/v1/utilities/system-settings/{key}` | Update global system setting |
