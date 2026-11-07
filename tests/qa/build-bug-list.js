// Builds docs/final-documentation/qa/QA_Bug_List.xlsx from the Jira issues found by the backend QA (snapshot 2026-10-18).
// Re-run after editing the table below (or paste a fresh Jira export into it).
const path = require('path'), fs = require('fs');
const XLSX = require(path.resolve(__dirname, '../../node_modules/xlsx'));
const JIRA = 'https://thekovain.atlassian.net/browse/';

// key, priority, status, type, area, found by, summary
const B = [
  ['ES-315', 'Highest', 'To Do', 'Bug', 'Savings', '08-savings', 'Saving Receipt/Payment cannot save at all - 500 column cheque_no of relation ledger does not exist'],
  ['ES-321', 'Highest', 'To Do', 'Bug', 'Loan', '10-loan-closure', 'Simultaneous loan repayments lose updates - ledger records 3 instalments but loan balance falls only once'],
  ['ES-322', 'Highest', 'To Do', 'Bug', 'Loan', '10-loan-closure', 'Early closure execute accepts a client adjustment of -999,999,999 and closes the loan for free'],
  ['ES-323', 'Highest', 'To Do', 'Bug', 'Deposits', '11-cd-journal-batch', 'Compulsory Deposit transaction cannot post (400 Database Error); income-head list is empty'],
  ['ES-327', 'Highest', 'To Do', 'Bug', 'Day End', '13-batches', 'Day-end blocked - process #13 stuck in_progress since 2026-09-20; nothing clears it'],
  ['ES-332', 'Highest', 'To Do', 'Bug', 'Reports', '14-reports-accuracy', 'Balance Sheet does not balance (liabilities 653.1M vs assets 666.0M) and does not match the General Ledger'],
  ['ES-356', 'Highest', 'To Do', 'Bug', 'Business Rules', '19-utilities', 'Business rules accept a negative or text loan rate and apply it globally (restored to 12.00 by QA)'],
  ['ES-361', 'Highest', 'Done', 'Bug', 'Security', 'code review + live probe', 'Ad-hoc report ran any SELECT typed by the user (including usermaster) - custom type removed (fixed 2026-10-18)'],
  ['ES-362', 'Highest', 'Done', 'Bug', 'Security', '25-roles', 'A clerk with Allow pass transactions OFF could pass, reverse and reject vouchers (fixed 2026-10-18: new PassAuthorityGuard)'],
  ['ES-363', 'Highest', 'Done', 'Bug', 'Security', 'certificate test', 'Path traversal in GET /deposits/certificates/download/{fileName} (fixed 2026-10-18)'],
  ['ES-374', 'Highest', 'To Do', 'Bug', 'Backup', '29-restore-copy', 'Restore on a database with data doubles every table (ledger, members, loans) and reports success'],
  ['ES-375', 'High', 'To Do', 'Bug', 'Backup', '29-restore-copy', 'Restore unusable: psql looked up on PATH (PSQL_PATH ignored); .sql.safe backups have no restore path; no safety backup'],
  ['ES-376', 'High', 'To Do', 'Bug', 'Backup', '29-restore-copy', 'Restore file name path traversal; weak/failing integrity check on large or cut-off dumps'],
  ['ES-258', 'High', 'To Do', 'Bug', 'Security', '01-route-sweep', 'An administrator can delete their own account (and no confirmation or approval)'],
  ['ES-260', 'High', 'To Do', 'Bug', 'Security', '01-route-sweep', 'PUT /auth/2fa/settings accepts an empty body and returns 200'],
  ['ES-261', 'High', 'Pending', 'Bug', 'Logging', 'log check', 'Log files are not written to ./logs (createWinstonConfig never used); decision needed'],
  ['ES-263', 'High', 'To Do', 'Bug', 'Backup', '17-backup-support', 'GET /admin/backup/list does not respond within 60-120 seconds (40 GB of backups)'],
  ['ES-267', 'High', 'To Do', 'Bug', 'Performance', '05-stress', 'Balance sheet report exhausts the DB connection pool: 500s for other users under 10+ concurrent calls'],
  ['ES-271', 'High', 'To Do', 'Bug', 'Migration', 'compare-migration', '6,456 newest legacy ledger rows missing in the new ledger'],
  ['ES-272', 'High', 'Pending', 'Bug', 'Migration', 'compare-migration', '572 legacy ledger rows replaced by test rows (same LedgerId); test rows dated up to 2030'],
  ['ES-274', 'High', 'Pending', 'Task', 'Migration', 'compare-migration', 'Decision: loan_master differs from legacy on 11,104 of 19,988 matching cases - confirm migration rules'],
  ['ES-309', 'High', 'To Do', 'Bug', 'Member', '06-member-write', 'save-member has no input validation (blank name, future birth date, negative salary/CD ...)'],
  ['ES-313', 'High', 'To Do', 'Bug', 'Voucher', '07-voucher', 'Voucher accepts zero, negative and absurd amounts, unknown type/member, invalid dates'],
  ['ES-316', 'High', 'To Do', 'Bug', 'Loan', '09-loan-lifecycle', 'Loan application with another member case number overwrites that case'],
  ['ES-317', 'High', 'To Do', 'Bug', 'Loan', '09-loan-lifecycle', 'Loan application accepts amount 0/negative, unknown member, installments 0, own surety, unknown type, date 2099'],
  ['ES-318', 'High', 'To Do', 'Bug', 'Loan', '09-loan-lifecycle', 'Sanction accepts negative amount, 10x applied amount, 0 installments'],
  ['ES-319', 'High', 'To Do', 'Bug', 'Loan', '09-loan-lifecycle', 'Two disbursement vouchers can be generated for the same sanctioned loan'],
  ['ES-320', 'High', 'To Do', 'Bug', 'Loan', '09-loan-lifecycle', 'Repayment accepts a payment far above the outstanding and silently discards the excess'],
  ['ES-325', 'High', 'To Do', 'Bug', 'Masters', '12-masters', 'REGRESSION: creating a master with an existing key overwrites the record (cast, designation, wing, office)'],
  ['ES-328', 'High', 'To Do', 'Bug', 'Dividend', '13-batches', 'Dividend commit accepts any rate (500%) and rewrites all rows'],
  ['ES-333', 'High', 'Pending', 'Bug', 'Reports', '14-reports-accuracy', 'Cash Book and Day Book disagree on opening balance; Day Book group totals differ from headline totals'],
  ['ES-334', 'High', 'Pending', 'Bug', 'Reports', '14-reports-accuracy', 'Ledger out of balance: credits exceed debits by 6.31M (legacy 242K)'],
  ['ES-353', 'High', 'To Do', 'Bug', 'RD', '15-rd', 'RD endpoints store NaN and impossible values; one NaN bypasses the minimum-balance rule'],
  ['ES-355', 'High', 'To Do', 'Bug', 'Backup', '17-backup-support', 'Backup verify reports new .sql.safe backups as corrupted; verify takes 35-190 s'],
  ['ES-357', 'High', 'To Do', 'Bug', 'Utilities', '19-utilities', 'Balance transfer accepts 0, negative, same account, unknown account, 1e12'],
  ['ES-360', 'High', 'To Do', 'Bug', 'Communication', '20-notifications', 'Comm hub queues empty/invalid messages, no recipient; duplicate EMI texts'],
  ['ES-364', 'High', 'To Do', 'Bug', 'Security', '25-roles', 'Admin-only routes open to every role: business-rules write, license list with keys, backup list'],
  ['ES-365', 'High', 'To Do', 'Bug', 'Interest', 'interest posting test', 'Interest posting fails as a whole when one member number has 10 digits (numeric(9) overflow)'],
  ['ES-366', 'High', 'To Do', 'Bug', 'Interest', 'interest posting test', 'Interest posted to ledger but sbmaster.balance not increased; wrong GL heads'],
  ['ES-367', 'High', 'To Do', 'Bug', 'Reports', '26-report-sweep', 'Loan Nil Certificate and Interest List reports return 400 Database operation failed'],
  ['ES-368', 'High', 'To Do', 'Bug', 'Documents', 're-agreement flow', 'PDF/PNG cannot be produced: font looked up in dist/assets/fonts (missing)'],
  ['ES-373', 'High', 'Done', 'Bug', 'Documents', '27-es362-es363', 'File downloads returned a JSON wrapper instead of the file (fixed 2026-10-18: interceptor passes files through)'],
  ['ES-369', 'High', 'To Do', 'Bug', 'Certificates', 'certificate test', 'Share certificate creation fails (400 Database Error, legacy members table)'],
  ['ES-259', 'Medium', 'Done', 'Bug', 'Member', '01-route-sweep', 'GET /members/balance/:memberNo 500 for unknown member (fixed 2026-10-18)'],
  ['ES-262', 'Medium', 'Done', 'Bug', 'Reports', '01-route-sweep', 'Eleven GET routes returned 500 for bad input (fixed 2026-10-18)'],
  ['ES-264', 'Medium', 'To Do', 'Bug', 'Performance', '01-route-sweep', 'Slow reads: surety-register 16 s, journal list 11 s, head-master 5 s, balance-sheet 4 s'],
  ['ES-265', 'Medium', 'Done', 'Bug', 'Loan', '03-loan-calc', 'calculate-emi: 500 / null results on invalid input (fixed 2026-10-18)'],
  ['ES-268', 'Medium', 'To Do', 'Bug', 'Security', '02-auth', 'API rate limiting not active; X-Powered-By exposed (decision on policy needed)'],
  ['ES-273', 'Medium', 'To Do', 'Bug', 'Migration', 'compare-migration', 'Members 990042370-73 missing; 91 members only in new'],
  ['ES-275', 'Medium', 'Pending', 'Task', 'Migration', 'compare-migration', 'Decision: legacy tables with data not migrated'],
  ['ES-310', 'Medium', 'Done', 'Bug', 'Member', '06-member-write', 'Member number preview consumed a number every call (fixed 2026-10-18)'],
  ['ES-311', 'Medium', 'Done', 'Bug', 'Member', '06-member-write', 'Update of unknown member returned 201 empty; array vs object (fixed 2026-10-18)'],
  ['ES-312', 'Medium', 'Done', 'Bug', 'Member', '06-member-write', 'GET/DELETE /members/:id failed with Database Error (fixed 2026-10-18)'],
  ['ES-314', 'Medium', 'Done', 'Bug', 'Voucher', '07-voucher', 'Voucher endpoints returned 500 instead of 4xx (fixed 2026-10-18)'],
  ['ES-326', 'Medium', 'Done', 'Bug', 'Masters', '12-masters', 'Wing/Office deletable while members use them (fixed 2026-10-18)'],
  ['ES-329', 'Medium', 'Done', 'Bug', 'Interest', '13-batches', 'Interest run with 0 members booked the period (fixed 2026-10-18)'],
  ['ES-330', 'Medium', 'To Do', 'Bug', 'Day End', '13-batches', 'Day-end ignores the client date; repeat request runs the next day (decision needed)'],
  ['ES-358', 'Medium', 'Done', 'Bug', 'Utilities', '19-utilities', 'Head master validation / 500 / empty code stored (fixed 2026-10-18)'],
  ['ES-359', 'Medium', 'Pending', 'Bug', 'Utilities', '19-utilities', 'Legacy receipt/payment/loan-entry endpoints: part fixed; FY current + empty slabs need decision'],
  ['ES-370', 'Medium', 'To Do', 'Bug', 'Dividend', '24-extra-modules', 'Share snapshot and month-end snapshot accept month 13 / year 1800 and write junk rows'],
  ['ES-371', 'Medium', 'To Do', 'Bug', 'Transactions', '24-extra-modules', '500 on empty bodies: dividend pay, short-recovery adjust, surety change; notice create Database Error'],
  ['ES-266', 'Low', 'Done', 'Bug', 'Security', '04-user-lifecycle', 'Usernames unique only case-sensitively (fixed 2026-10-18)'],
  ['ES-324', 'Low', 'Done', 'Bug', 'Transactions', '11-cd-journal-batch', 'Journal accepts same head on debit and credit (fixed 2026-10-18)'],
  ['ES-331', 'Low', 'Done', 'Bug', 'Logging', 'owner console paste', 'Handled 4xx logged at ERROR with stack trace (fixed 2026-10-18)'],
  ['ES-354', 'Low', 'Done', 'Bug', 'Demand', '16-demand', 'Demand generate invalid month/year 500, year 1800 accepted (fixed 2026-10-18)'],
  ['ES-372', 'Low', 'To Do', 'Bug', 'Platform', '24-extra-modules', 'POST /ai-chat and /analytics/* return 404 (modules not mounted)'],
  ['ES-377', 'High', 'Pending', 'Task', 'Business Logic', 'data check', '256 running loans above 5 lakh where shares are below 5% of the loan; 3,149 running-loan members have 0 shares'],
  ['ES-378', 'Medium', 'Pending', 'Task', 'Business Logic', 'data check', '134 loans with negative balance (-2,86,680): overpayment / refund rule'],
  ['ES-379', 'High', 'Pending', 'Task', 'Business Logic', 'data check', '56 running loans (Rs 55.3 lakh) belong to members missing from member_master'],
  ['ES-380', 'Medium', 'Pending', 'Task', 'Business Logic', 'data check', '641 member/loan-type pairs hold two running loans of the same type - allowed?'],
  ['ES-381', 'Medium', 'Pending', 'Task', 'Business Logic', 'data check', 'Savings/share anomalies: negative SB opening -5,000, several SB accounts per member, negative share balance'],
  ['ES-382', 'Medium', 'Pending', 'Task', 'Business Logic', 'data check', 'Member dates: 1,217 retire on 1900-01-01, 88 under 18 at joining, birth dates in 2030/2099'],
  ['ES-383', 'Medium', 'Pending', 'Task', 'QA', 'postponed', 'Test alert delivery, group insurance post and dividend credit commit on spare backend 3002 (postponed by owner)'],
  ['ES-512', 'Medium', 'To Do', 'Bug', 'Pass Transactions', 'playwright 2026-11-07', 'Pending voucher grid: ACC HEAD, TRANS TYPE, TR. NO. empty in all 78 rows and no detail view although API returns breakdown; approver passes money blind'],
  ['ES-511', 'High', 'To Do', 'Bug', 'Member Balance Transfer', 'playwright + static route check 2026-11-07', 'Generate and Post return 404 (Cannot POST /transactions/member-balance-transfer/generate|post): MemberBalanceTransferService has no controller and is not in any module; window unusable, ES-421 untestable'],
  ['ES-510', 'Low', 'To Do', 'Bug', 'Interest Posting', 'playwright interest preview 2026-11-07', 'SB interest preview takes ~10 s API (30 s+ UI) for 5 accounts: loops queries over all ~8,500 active members instead of sbmaster accounts'],
  ['ES-509', 'Medium', 'To Do', 'Bug', 'RD Member Setup', 'playwright RD 2026-11-07', 'RD amount history shows "Set by system" (no user sent); "Takes effect immediately" but current month (Nov) still expects Rs 0'],
  ['ES-508', 'High', 'To Do', 'Bug', 'RD Repayment', 'playwright RD 2026-11-07', 'RD counter payment saved only in rd_installment_ledger: no receipt/ledger/cash rows (Day Book, Cash Book, Day-End miss it); second payment for same month overwrites the first (300 became 50)'],
  ['ES-507', 'High', 'To Do', 'Bug', 'Loan Payment', 'playwright loan flow 2026-11-07', 'Disbursement voucher save fails 400 "breakdown lines add up to 11000, but voucher total is 9000": backend adds Receipt deduction lines instead of subtracting, so loans with RD/share shortfall cannot be disbursed'],
  ['ES-506', 'High', 'To Do', 'Bug', 'Loan Sanction', 'playwright loan flow 2026-11-07', 'Sanction screen rate/penalty % accepted (200) but never stored (loan_pending.rate/penalrate NULL), loan priced at default 12.5%; displayed EMI = principal/n (83/167) and Total Interest empty vs real EMI 111.22/222.44'],
  ['ES-505', 'Medium', 'To Do', 'Bug', 'Loan Application', 'playwright loan form 2026-11-07', 'Loan Amount field strips the decimal point: 100.50 becomes 10050 (100x), 100.555 becomes 100555; Save validation allows 2 decimals so the rules contradict'],
  ['ES-504', 'Medium', 'To Do', 'Bug', 'Loan Application', 'playwright loan form 2026-11-07', 'Financial Summary (Shares / Regular / Emergency loan) always Rs 0: page calls GET /loans/member/:mbno/balances which does not exist (404 swallowed)'],
  ['ES-502', 'Medium', 'To Do', 'Bug', 'Utility / Find', 'playwright screen check 2026-11-06', 'Find window: WING, DIVISION, A/C NO and SR NO columns always "-" (mapping drops them; backend packs office into details text)'],
  ['ES-501', 'High', 'To Do', 'Bug', 'Saving', 'playwright write flow 2026-11-06', 'Saving Voucher balances panel and history stay 0 (double-wrapped GET /utilities/saving/account/:no), so every SB withdrawal is refused "Withdrawable balance is 0.00"'],
  ['ES-500', 'High', 'To Do', 'Bug', 'Journal Transfer', 'playwright UI test 2026-11-06', 'Journal Transfer Member-To-Member: member number cannot be entered (MBNO/NAME cells read-only, nothing opens the lookup) so transfer cannot be posted'],
  ['ES-492', 'High', 'To Do', 'Bug', 'Masters / Member', 'playwright write flow 2026-11-06', 'Member Master stores wing NAME ("BHILAI") in member_master.wingno instead of code ("1"); new members show "Unknown Office" and miss wing/office joins'],
  ['ES-491', 'High', 'To Do', 'Bug', 'Masters / Demand', 'frontend sweep 2026-11-05','GET /admin/member-funds/wings returns 400 (no wings route): Wing dropdown empty in Modify Member Balance, Modify Short Recovery, Print Members Demand List'],
];
const BL = [
  ['Jira key', 'Priority', 'Status', 'Business rule in question', 'What the data / tests show', 'Decision needed from owner'],
  ['ES-377', 'High', 'Pending', '5% of loan as shares (loans above 5 lakh)', '256 running loans above 5 lakh with shares below 5%; 3,149 running-loan members have 0 shares', 'Does the rule apply to migrated loans? Flag, block top-ups, or ignore?'],
  ['ES-378', 'Medium', 'Pending', 'Overpayment on a loan', '134 loans have negative balance, total -2,86,680; app drops the excess silently (ES-320)', 'Refund, move to SB/CD/share, or keep as advance?'],
  ['ES-379', 'High', 'Pending', 'Loan must belong to a member', '56 running loans (5,529,372) have no member_master record', 'Migrate the members, write off, or re-map?'],
  ['ES-380', 'Medium', 'Pending', 'One running loan of a type per member', '641 member + type pairs with 2 running loans (ALN/RLN); application does not refuse (ES-316/317)', 'Allowed or must be consolidated?'],
  ['ES-381', 'Medium', 'Pending', 'SB accounts and share balance', 'SB 203 opened with -5,000; 2 members with several SB accounts; share balance -1,000', 'Max SB accounts per member? Minimum opening amount? Negative shares?'],
  ['ES-382', 'Medium', 'Pending', 'Member age / retirement date', '1,217 members dor 1900-01-01; 88 joined under 18; DOB 2030 and 2099', 'Placeholder meaning "no retirement date", minimum age'],
  ['ES-333', 'High', 'Pending', 'Opening balance of Cash Book vs Day Book', 'The two reports differ on opening balance and group totals', 'Which definition is correct'],
  ['ES-334', 'High', 'Pending', 'Ledger must balance', 'Credits exceed debits by 6.31M (legacy 242K)', 'Is single-entry ledger accepted? Which entries are real?'],
  ['ES-274', 'High', 'Pending', 'Loan data migration', 'loan_master differs from legacy on 11,104 of 19,988 cases', 'Confirm migration rules (principal vs total instalment)'],
  ['ES-275', 'Medium', 'Pending', 'Unmigrated legacy tables', 'Legacy tables with data are not in the new system', 'Which are needed'],
  ['ES-272', 'High', 'Pending', 'Ledger ids from legacy', '572 legacy ledger ids replaced by test rows dated up to 2030', 'Allow clean-up of test rows?'],
  ['ES-330', 'Medium', 'Pending', 'Day-end date', 'Day-end ignores the client date; repeat request runs next day', 'Intended behaviour'],
  ['ES-268', 'Medium', 'To Do', 'API rate limiting policy', 'Throttler not active', 'Limit values'],
  ['ES-261', 'High', 'Pending', 'Log files', 'No log files written to ./logs', 'Log folder, retention'],
  ['ES-359', 'Medium', 'Pending', 'Financial year "current" and empty slabs', 'FY current returns a future year; empty slabs accepted', 'Rule for current FY and slabs'],
  ['ES-356', 'Highest', 'To Do', 'Business rule value ranges', 'Loan rate accepts negative or text', 'Allowed range for each rule'],
  ['ES-328', 'High', 'To Do', 'Dividend rate range', 'Rate 500% accepted', 'Maximum dividend rate'],
];
const RANK = { Highest: 0, High: 1, Medium: 2, Low: 3 };
B.sort((a, b) => RANK[a[1]] - RANK[b[1]] || (a[2] === 'Done') - (b[2] === 'Done') || a[0].localeCompare(b[0]));
const sev = { Highest: 'P0 - fix before release (money / security / data)', High: 'P1 - fix this sprint', Medium: 'P2 - plan next', Low: 'P3 - when convenient' };
const rows = B.map(([k, p, st, ty, area, by, sum]) => ({ 'Jira key': k, Priority: p, Meaning: sev[p], Status: st, Type: ty, Area: area, 'Found by': by, Summary: sum, Link: JIRA + k }));
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(rows);
rows.forEach((r, i) => { const c = ws['I' + (i + 2)]; if (c) c.l = { Target: r.Link }; });
ws['!cols'] = [10, 9, 44, 9, 7, 16, 24, 110, 40].map(w => ({ wch: w }));
ws['!autofilter'] = { ref: `A1:I${rows.length + 1}` };
ws['!freeze'] = { xSplit: 0, ySplit: 1 };
XLSX.utils.book_append_sheet(wb, ws, 'Bug List by Priority');

const count = (f) => { const o = {}; B.forEach(x => { const k = f(x); o[k] = (o[k] || 0) + 1; }); return o; };
const open = B.filter(x => x[2] !== 'Done');
const sum = [['QA bug summary (Jira project ES, snapshot 2026-10-18)'], [''], ['Total items', B.length], ['Open (not Done)', open.length], ['Done (fixed and verified)', B.length - open.length], [''],
  ['Priority', 'Total', 'Open', 'Done']];
for (const p of ['Highest', 'High', 'Medium', 'Low']) sum.push([p, B.filter(x => x[1] === p).length, open.filter(x => x[1] === p).length, B.filter(x => x[1] === p && x[2] === 'Done').length]);
sum.push([''], ['Status', 'Count']); Object.entries(count(x => x[2])).forEach(e => sum.push(e));
sum.push([''], ['Area', 'Open items']); Object.entries(open.reduce((o, x) => { o[x[4]] = (o[x[4]] || 0) + 1; return o; }, {})).sort((a, b) => b[1] - a[1]).forEach(e => sum.push(e));
sum.push([''], ['Priority meaning'], ['Highest', sev.Highest], ['High', sev.High], ['Medium', sev.Medium], ['Low', sev.Low], [''], ['Notes', 'Pending = needs an owner decision. Done = fixed in code, verified live by a test, Jira commented; nothing was committed to git.']);
const ws2 = XLSX.utils.aoa_to_sheet(sum); ws2['!cols'] = [34, 70, 10, 10].map(w => ({ wch: w }));
XLSX.utils.book_append_sheet(wb, ws2, 'Summary');

const untested = [
  ['Area', 'Status', 'Why / what is needed'],
  ['Backup restore', 'TESTED on a spare copy database (2026-10-18)', 'Result: 3 bugs ES-374/375/376; restore into an empty DB is exact, restore onto existing data doubles it'],
  ['Print / PDF layout on paper, Excel exports from the screens', 'Not tested', 'Needs the Electron UI; PDF generation itself is blocked by ES-368'],
  ['Frontend screens (all windows)', 'Not tested here', 'Use the Manual_Regression_Test_Plan.xlsx workbook'],
  ['Dividend credit commit, group insurance post, license activate', 'PENDING - postponed by owner (ES-383)', 'Needs the spare backend on port 3002 (EMP_QA_RestoreCopy is ready); the 3002 backend did not start last time'],
  ['Excel exports from screens', 'Not applicable to the backend', 'The backend has no Excel export routes; exports are produced by the frontend screens'],
  ['Business-rule data checks (loans, SB, shares, member dates)', 'Done 2026-10-18', 'Read-only SQL; results are in the Business Logic Issues sheet (ES-377..382)'],
  ['Fixed deposits', 'Skipped', 'On hold by decision (ES-1xx)'],
  ['Alerts / Telegram delivery', 'PENDING - postponed (ES-383)', 'Settings read and validation only; no message was sent to Telegram, Jira or e-mail'],
  ['Report accuracy for ~40 of the 52 report routes', 'Partly', 'Sweep checks status, speed and bad values; only Daybook, Cashbook, GL, Member Ledger, Balance Sheet were tied to the ledger'],
  ['Saving interest with many members', 'Partly', 'Math verified for 1 member (900000002); full run blocked by ES-365'],
];
const ws3 = XLSX.utils.aoa_to_sheet(untested); ws3['!cols'] = [58, 16, 100].map(w => ({ wch: w }));
XLSX.utils.book_append_sheet(wb, ws3, 'Not Tested');

const clean = [
  ['Leftover from QA', 'Where', 'Note'],
  ['QATEST members (9999962445 - 9999962540 range)', 'member_master (+ fundsmaster, member_balances)', "select mbno from member_master where f_name='QATEST'; DELETE /members/:id now works for empty ones (ES-312)"],
  ['QA vouchers VCH266 - VCH330, some passed/reversed', 'vouchers, transactions, ledger', 'Pending ones were rejected by the suites'],
  ['QA loans 889200 - 889229 (junk pending cases 889201-889209, 889214-889222)', 'loan_pending, loan_master, loan_repayment_ledger', 'Closed QA loans and a re-agreement RA00022 (cancelled) / RA00023 (passed)'],
  ['SB account 213 and QA ledger rows (QA transfer, QA journal, QA 359 payment)', 'sbmaster, ledger', 'Includes rows for non-existent member 1999999999'],
  ['Demand rows JAN, FEB, MAR 2031 and JAN 1800', 'demand_master', 'Created by suite 16'],
  ['Playwright UI tests 2026-11-06: members 9999962666 and 9999962667 (QAPW MEMBERONE, wingno BHILAI) and receipt R58411 (100.00 CD, ledger trans_no 208505-208506)', 'member_master, ledger', 'Created via the real screens by Frontend/tests/qa-ui scripts; see ES-492'],
  ['Playwright saving deposits R58412-R58415 (50, 50, 20, 20) on SB account 213 (member 9999962472)', 'sbmaster, ledger', 'Created by qa-ui-saving-flow.mjs; ES-501'],
  ['Playwright SB accounts 216 and 217 (Rs 100 each, ledger R58416, R58417) for member 9999962666; RD config 200 then 300 and RD installment Dec 2026 (paid 50) in rd_member_config / rd_installment_ledger', 'sbmaster, ledger, rd_*', 'Created by qa-ui-sb-open.mjs (twice) and qa-ui-rd-write.mjs; ES-508/509'],
  ['Playwright user qa_pw_user1 (usermaster userid 71, level SYSTEM, password generated and not recorded)', 'usermaster', 'Created by qa-ui-user-create.mjs. Safe to delete'],
  ['Playwright loan cases 889279 (Rs 10,000, sanctioned) and 889280 (Rs 5,000, sanctioned, rate 9 ignored) for member 9999962667; not disbursed', 'loan_pending', 'Created by qa-ui-loan-app-submit.mjs + qa-ui-loan-sanction.mjs; ES-504/505/506. Safe to delete: no ledger rows'],
  ['RD rows for member 9999962480 with NaN values', 'rd_member_config, rd_installment_ledger', 'ES-353'],
  ['Junk head with empty code', 'headmaster', 'Cannot be deleted through the API'],
  ['Junk snapshot periods 1800/9 and 2026/13 (13,120 rows)', 'share_monthly_balance, loan_monthly_balance', 'ES-370'],
  ['Interest runs J34186 (Apr-Jun 2026, 0 members) and J34205 (Oct 1-17, member 900000002 only)', 'interestmaster, interestpaid, ledger', 'Each blocks its period'],
  ['Dividend master year 2026 rewritten at 10% (5,144 rows) and a 2027 commit for year code 2', 'dividend_master', 'Restored to 10%'],
  ['Day End process 13 marked failed (owner approved); process 14 completed; working date now 2026-08-25', 'day_end_processes, getworkingdate', ''],
  ['Spare copy database EMP_QA_RestoreCopy (re-created fresh from live on 2026-10-18, ~1.5 GB; kept for ES-383) plus db-config.copy.json and folder F:\company\qa-restore-test (1.3 GB dump + checksum file)', 'PostgreSQL server / disk F:', 'Drop with: DROP DATABASE "EMP_QA_RestoreCopy"; and delete the folder when no longer needed'],
  ['Support ticket SQ-00008', 'support_queries / Jira SPT', 'Close it'],
  ['Cancelled QA notifications; automatic alerts queued without recipient', 'notification_logs', 'ES-360'],
  ['Backups created: dayend_2026-08-23_...sql (1.3 GB, normal)', 'backups/', ''],
];
const ws4 = XLSX.utils.aoa_to_sheet(clean); ws4['!cols'] = [86, 52, 90].map(w => ({ wch: w }));
XLSX.utils.book_append_sheet(wb, ws4, 'QA Leftovers');
const ws5 = XLSX.utils.aoa_to_sheet(BL); ws5['!cols'] = [10, 9, 9, 42, 90, 70].map(w => ({ wch: w }));
BL.slice(1).forEach((r, i) => { const c = ws5['A' + (i + 2)]; if (c) c.l = { Target: JIRA + r[0] }; });
XLSX.utils.book_append_sheet(wb, ws5, 'Business Logic Issues');
const out = path.resolve(__dirname, '../../../docs/final-documentation/qa');
fs.mkdirSync(out, { recursive: true });
XLSX.writeFile(wb, path.join(out, 'QA_Bug_List.xlsx'));
console.log('written', B.length, 'items;', open.length, 'open');
