// Generates docs/final-documentation/qa/Manual_Regression_Test_Plan.xlsx  (run: node tests/qa/build-manual-tests.js)
// Uses SheetJS from the Frontend's node_modules. Sheets: How To Use, Release Gate, Test Cases, Window Index, Test Data, Bug Log, Run Sheet.
const path = require('path'), fs = require('fs');
const XLSX = require(path.resolve(__dirname, '../../node_modules/xlsx'));

const rows = []; let n = 0;
const T = (module, menu, window, kind, blocker, pre, steps, data, expected) => {
  n++; rows.push({ ID: 'TC-' + String(n).padStart(3, '0'), 'Release Blocker': blocker ? 'YES' : 'no', Module: module, 'Menu Path': menu, Window: window, Type: kind,
    Preconditions: pre, 'Steps (do this)': steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), 'Example Test Data': data, 'Expected Result': expected,
    'Result (Pass/Fail)': '', Tester: '', 'Date Tested': '', 'Defect ID (Jira)': '', Notes: '' });
};
const LOGIN = 'Logged in as an administrator test user';

// ---------------------------------------------------------------- 1. Sign-in & security
T('Security', 'Login screen', 'Login', 'Happy path', true, 'Backend running; test user exists', ['Open the app', 'Enter username and password', 'Click Login'], 'Test user QA_USER_Test / its password', 'Dashboard opens; your name shows in the header; no error.');
T('Security', 'Login screen', 'Login', 'Negative', true, 'Test user exists', ['Enter the right username with a WRONG password', 'Click Login'], 'Password: wrong123', 'Message "Invalid credentials". Not logged in. Same message appears for a user name that does not exist.');
T('Security', 'Login screen', 'Login', 'Negative', false, '-', ['Leave username and password empty', 'Click Login'], 'empty', 'Validation message; no server error screen.');
T('Security', 'Login screen', 'Login', 'Security', true, '-', ['Type  \' OR \'1\'=\'1  in username and password', 'Click Login'], "' OR '1'='1", 'Login refused. App does not crash.');
T('Security', 'Login screen', 'Login (disabled user)', 'Negative', true, 'A test user is switched to Account Active = OFF', ['Try to log in with that user'], 'disabled test user', 'Login refused with "User account is disabled".');
T('Security', 'File > Exit / header', 'Logout', 'Happy path', true, LOGIN, ['Click your name / Logout', 'Press the browser/app Back or reopen the app'], '-', 'Returns to Login. The old session cannot be reused.');
T('Security', 'Administration > Security > Change Password', 'Change Password', 'Happy path', true, LOGIN, ['Open Change Password', 'Enter current password, new password twice', 'Save', 'Logout and login with the new password'], 'New: Test@4567', 'Password changes; old password stops working; new works.');
T('Security', 'Administration > Security > Change Password', 'Change Password', 'Negative', true, LOGIN, ['Enter a WRONG current password', 'Save'], '-', 'Refused; password unchanged.');
T('Security', 'Administration > Security > Change Password', 'Change Password', 'Negative', false, LOGIN, ['New password shorter than 6 characters', 'Save'], 'abc', 'Refused with a clear message.');
T('Security', 'Administration > Security > Create / Modify Users', 'Create / Modify Users', 'Happy path', true, 'Administrator', ['Open Create / Modify Users', 'Create user QA_TMP_01 with level DATA OPERATOR and a password', 'Save', 'Login as QA_TMP_01'], 'QA_TMP_01 / Tmp#12345', 'User created; can log in; sees only the menus their level allows.');
T('Security', 'Administration > Security > Create / Modify Users', 'Create / Modify Users', 'Negative', false, 'Administrator', ['Create the same username again'], 'QA_TMP_01', 'Refused (duplicate).');
T('Security', 'Administration > Security > Create / Modify Users', 'Create / Modify Users', 'Security', true, 'Test user QA_TMP_01 (DATA OPERATOR) logged in', ['Look for Administration > Security menus', 'Try opening Create / Modify Users from search (Ctrl+K) if visible'], '-', 'Low-privilege user cannot manage users, backup, day-end or finance-year screens.');
T('Security', 'Administration > Security > Create / Modify Users', 'Delete user (ONLY test users)', 'Happy path', false, 'Create a throwaway user first (QA_TMP_DEL)', ['Select QA_TMP_DEL', 'Delete', 'Try to login as QA_TMP_DEL'], 'QA_TMP_DEL', 'User removed and cannot log in. NEVER delete a real user while testing.');
T('Security', 'Administration > Security > Create / Modify Users', 'Delete own account', 'Security', true, LOGIN + ' (use a spare admin test account)', ['Try to delete the account you are logged in with'], 'own account', 'EXPECTED: refused. (Known gap ES-258: currently succeeds - do NOT run on a real admin.)');
T('Security', 'Administration > Security > Configure UserLevel Default Rights', 'Role rights', 'Regression', true, 'Administrator', ['Remove "Loan Application" right from level DATA OPERATOR', 'Login as a DATA OPERATOR user', 'Look for Loan Application'], '-', 'Menu hidden / action refused for that level; restoring the right brings it back.');
T('Security', 'Administration > Security > Two-Factor & Approvals', 'Two-Factor & Approvals', 'Happy path', true, 'Administrator with authenticator app', ['Open My Profile and set up authenticator', 'Logout and login again', 'Enter the 6-digit code'], 'Authenticator app code', 'Code accepted; wrong code refused; same code cannot be used twice.');
T('Security', 'Administration > Security > Two-Factor & Approvals', 'Policy switch', 'Regression', false, 'Administrator', ['Switch "Ask for authenticator code when signing in" OFF', 'Logout and login with only username/password', 'Switch it ON again'], '-', 'No code asked while OFF; Forgot password still asks for a code; setting survives restart.');
T('Security', 'Administration > Security > LogOut User', 'LogOut User', 'Happy path', false, 'Two test users logged in', ['Open LogOut User', 'Force logout the test user (not yourself)'], 'QA_TMP_01', 'That user is thrown back to login on the next action.');

// ---------------------------------------------------------------- 2. Members
T('Member', 'Masters > Member Master', 'Member Master', 'Happy path', true, LOGIN, ['Open Member Master', 'Click New / Generate member number', 'Fill name, father name, office, wing, DOB, address, phone, joining date', 'Save'], 'Name: QA TEST MEMBER ONE', 'Saved with a new member number; appears in Find / lookup; no duplicate created on second click of Save.');
T('Member', 'Masters > Member Master', 'Member Master', 'Negative', true, LOGIN, ['Save with Name empty', 'Save with an invalid date of birth (31-02-1990)', 'Save with phone containing letters'], '-', 'Each case blocked with a field-level message; nothing saved.');
T('Member', 'Masters > Member Master', 'Member Master', 'Edge', false, LOGIN, ['Enter a 300-character name', 'Enter special characters  & < > \' "', 'Save and reopen the member'], 'O\'Brien & Sons <test>', 'Saved as typed or rejected cleanly; reopening shows the same text; no broken screen.');
T('Member', 'Masters > Member Master', 'Member Master - search', 'Happy path', true, 'Several members exist', ['Search by member number', 'Search by part of name', 'Search a number that does not exist'], 'Existing member no.; "KAVITA"; 111', 'Correct member opens; list filters; "not found" message, not an error page.');
T('Member', 'Masters > Member Master', 'Photo / Signature / Documents upload', 'Happy path', false, 'Test member exists', ['Upload a small JPG photo', 'Upload a signature', 'Upload a PDF document', 'Reopen the member'], 'files under 1 MB', 'Files show after reopen; a .exe renamed .jpg is refused.');
T('Member', 'Masters > Member Master', 'Member Master - delete', 'Happy path', false, 'Create a throwaway member QA DELETE ME with no transactions', ['Delete that member only'], 'QA DELETE ME', 'Allowed only for a member with no accounts; a member with loans/deposits cannot be deleted. NEVER delete a real member.');
T('Member', 'Masters > Member Status (Retired / Inactive)', 'Member Status', 'Happy path', false, 'Test member', ['Mark the test member Retired', 'Open Loan Application for that member'], '-', 'Status saved; related screens show the warning; reverting works.');
T('Member', 'Masters > Modify Member Balance', 'Modify Member Balance', 'Happy path', true, 'Test member with share/CD balance', ['Change share balance by a small amount', 'Save', 'Open Member Ledger Report'], '+100.00', 'Balance changes; a ledger entry exists for the change; old and new values can be traced.');
T('Member', 'Utility > Member Balance', 'Member Balance', 'Happy path', false, 'Test member with loan + deposit', ['Enter member number', 'Compare with Member Ledger Report'], 'e.g. 9999962386', 'Same balances in both places.');
T('Member', 'Masters > Wing / Office Master', 'Wing / Office Master', 'Regression', false, LOGIN, ['Add a test wing "QA WING"', 'Add a test office under it', 'Edit the name', 'Check the Wing -> Office dropdown in Member Master'], 'QA WING / QA OFFICE', 'Dropdown shows the new wing/office; editing one record does not overwrite others.');
T('Member', 'Masters > Cast Category / Designation Master', 'Cast Category / Designation', 'Regression', false, LOGIN, ['Add test record', 'Add a second record with a different code', 'Edit the first', 'Check both still exist'], 'QA CAST 1 / QA CAST 2', 'Records stay separate (earlier bug: create overwrote existing).');

// ---------------------------------------------------------------- 3. Loans (core)
const LNPRE = LOGIN + '; test member with share balance, office set, no pending loan';
T('Loan', 'Administration > Loan > Loan Application', 'Loan Application', 'Happy path', true, LNPRE, ['Open Loan Application', 'Enter member number', 'Pick loan type (e.g. RLN)', 'Enter amount 50000 and tenure 24 months', 'Check the EMI shown', 'Add the required sureties', 'Save'], 'Amount 50000, 24 months, interest as per rules', 'Application saved with a case number; EMI equals the Calculator/EMI Chart value for the same inputs; shows under pending loans.');
T('Loan', 'Administration > Loan > Loan Application', 'Loan Application', 'Negative', true, LNPRE, ['Enter amount 0', 'Enter a negative amount', 'Enter tenure 0', 'Enter amount above the member limit'], '0 / -5000 / 0 / 99999999', 'Each blocked with a clear message; no case number consumed.');
T('Loan', 'Administration > Loan > Loan Application', 'Loan Application', 'Negative', true, LNPRE, ['Make the member their own surety', 'Use a surety who is already at the surety limit', 'Use a non-existent surety number'], '-', 'Each refused with reason.');
T('Loan', 'Administration > Loan > Loan Application', 'Loan Application', 'Edge', false, LNPRE, ['Double-click Save quickly'], '-', 'Only ONE application is created.');
T('Loan', 'Administration > Loan > Loan Application', 'Loan Application - eligibility', 'Regression', true, 'Member with an existing running loan', ['Apply for a new loan', 'Read the eligibility / consolidation messages'], '-', 'Existing loan is shown; slot / consolidation rules are applied as in the Loan Calculation Pipeline document.');
T('Loan', 'Transaction > Pass Transactions', 'Loan sanction / disbursement', 'Happy path', true, 'Pending loan application exists (from above)', ['Open Pass Transactions', 'Select the loan voucher', 'Pass it', 'Open Member Loan Ledger'], 'case from TC above', 'Loan becomes sanctioned; ledger shows disbursement; cash/bank head moves by the exact amount; voucher cannot be passed twice.');
T('Loan', 'Transaction > Loan Repayment', 'Loan Repayment', 'Happy path', true, 'Sanctioned loan with EMI due', ['Open Loan Repayment', 'Enter member + case', 'Read the Loan Position panel', 'Enter exactly the EMI amount', 'Save', 'Open Loan Account Statement'], 'EMI amount shown', 'Principal and interest split as per schedule; balance falls by the principal part; receipt number given; statement shows ONE new row.');
T('Loan', 'Transaction > Loan Repayment', 'Loan Repayment', 'Edge', true, 'Same', ['Pay LESS than the EMI', 'Pay MORE than the EMI', 'Pay more than the full outstanding'], 'EMI-500 / EMI+500 / outstanding+1000', 'Part payment accepted per rule and reflected; excess handled per rule or refused; never a negative balance.');
T('Loan', 'Transaction > Loan Repayment', 'Loan Repayment', 'Negative', true, 'Same', ['Pay amount 0', 'Pay a negative amount', 'Pay with letters in amount', 'Wrong case number for the member'], '0 / -100 / abc / other member\'s case', 'All refused; nothing posted; statement unchanged.');
T('Loan', 'Transaction > Loan Repayment', 'Loan Repayment - double submit', 'Edge', true, 'Same', ['Click Save twice quickly'], '-', 'Posted once only.');
T('Loan', 'Transaction > Loan Repayment', 'Loan Repayment - late payment', 'Regression', true, 'Loan with overdue months', ['Pay the overdue EMI', 'Check penalty line'], 'overdue case', 'Penalty matches the tiered penalty rule; demand-month money pays its own month first.');
T('Loan', 'Transaction > Loan Early Closure', 'Loan Early Closure', 'Happy path', true, 'Running loan', ['Open Loan Early Closure', 'Select member and case', 'Read the quote (it must not change data)', 'Type the confirmation text', 'Execute'], 'closure today', 'Quote shows principal + interest to date (+ RD share if applicable); after Execute loan is closed, balance 0, ledger entries correct; running the quote twice gives the same numbers.');
T('Loan', 'Transaction > Loan Early Closure', 'Loan Early Closure', 'Negative', true, 'Same', ['Execute without typing the confirmation', 'Execute on an already closed loan', 'Use an invalid closure date'], '-', 'Refused each time; no double posting.');
T('Loan', 'Transaction > Loan Re-agreement', 'Loan Re-agreement', 'Happy path', true, 'Eligible running loan', ['Open Loan Re-agreement', 'Select the loan', 'Get quote', 'Apply', 'Pass it', 'Open the saved agreement document'], '-', 'New case created with the restructured terms; old case closed/linked; agreement PDF/PNG opens; history report shows the chain.');
T('Loan', 'Administration > Loan > Change Loan Surety', 'Change Loan Surety', 'Happy path', false, 'Running loan with surety', ['Change one surety to another eligible member', 'Save', 'Open Surety Register'], '-', 'Register shows the new surety; old surety released.');
T('Loan', 'Utility > EMI Chart / Calculator', 'EMI Chart / Calculator', 'Happy path', true, '-', ['Enter principal 100000, rate 12, 12 months'], '100000 / 12 / 12', 'EMI = 8884.88; total interest 6618.55; last balance 0.');
T('Loan', 'Utility > EMI Chart / Calculator', 'EMI Chart / Calculator', 'Negative', false, '-', ['Try principal -1', 'tenure 0', 'empty fields'], '-', 'Message shown; no blank/NaN values and no error page (known gap ES-265).');
T('Loan', 'Reports > 4. Monthly > 4.8 Loan Account Statement', 'Loan Account Statement', 'Regression', true, 'Member with repayments', ['Open the statement', 'Count the rows against the receipts you made'], '-', 'No duplicated rows; summary belongs to the same member (earlier bug ES-212).');
T('Loan', 'Reports > 4.7 Member Loan Ledger', 'Member Loan Ledger', 'Regression', true, 'Same', ['Compare closing balance with Loan Repayment screen'], '-', 'Same outstanding in both.');

// ---------------------------------------------------------------- 4. Deposits
T('Deposits', 'Masters > Saving A/c Opening', 'Saving A/c Opening', 'Happy path', true, 'Test member', ['Open an SB account for the member', 'Save', 'Find the account number in Saving Receipt/Payment'], '-', 'Account created once; opening balance 0 or as entered.');
T('Deposits', 'Transaction > Saving [Receipt -- Payment]', 'Saving Receipt', 'Happy path', true, 'SB account', ['Receipt of 5000', 'Check balance', 'Payment of 2000', 'Check balance'], '5000 then 2000', 'Balance 3000; two ledger entries; Day Book shows both.');
T('Deposits', 'Transaction > Saving [Receipt -- Payment]', 'Saving Payment', 'Negative', true, 'SB balance 3000', ['Withdraw 5000', 'Withdraw 0', 'Withdraw -100'], '5000 / 0 / -100', 'Overdraft refused; zero/negative refused; balance unchanged.');
T('Deposits', 'Transaction > Saving [Receipt -- Payment]', 'Saving - double submit', 'Edge', true, 'SB account', ['Click Save twice on a receipt'], '-', 'One entry only.');
T('Deposits', 'Masters > RD Member Setup / RD Repayment / RD Withdrawal', 'RD', 'Happy path', true, 'Test member', ['Set up RD for the financial year', 'Post one monthly instalment', 'View RD Statement'], '-', 'Instalment posts once; statement shows it; RD lien rule blocks withdrawal beyond free amount when a loan against RD exists.');
T('Deposits', 'Masters > RD Withdrawal', 'RD Withdrawal', 'Negative', true, 'RD with lien (Loan Against RD)', ['Withdraw more than the free (unlocked) RD'], '-', 'Refused with reason.');
T('Deposits', 'Transaction > Compulsory Deposit Transaction', 'Compulsory Deposit', 'Happy path', true, 'Test members', ['Post compulsory deposit for one member', 'Check Member Ledger'], '-', 'Posted once; ledger and Day Book agree.');
T('Deposits', 'Administration > Group Insurance', 'Group Insurance', 'Regression', false, 'RD members', ['Run the yearly deduction preview', 'Check amount against the rule'], '-', 'Amount per rule; not deducted twice.');
T('Deposits', 'Administration > RD Financial Year Closing', 'RD FY Closing', 'Regression', true, 'Test financial year only', ['Preview closing', 'Do NOT execute on real data'], '-', 'Preview totals match RD Statement; execute only on a copy/test database.');
T('Deposits', 'FD screens', 'Fixed Deposit', 'Info', false, '-', ['FD is ON HOLD (ES-17x); do not test or change'], '-', 'Skip.');

// ---------------------------------------------------------------- 5. Transactions
T('Transactions', 'Transaction > Receipt & Payment > Payment Voucher Creation', 'Payment Voucher Creation', 'Happy path', true, LOGIN, ['Create a payment voucher for head Cash/Bank and an expense head', 'Save'], 'amount 1500', 'Voucher number issued; pending until passed.');
T('Transactions', 'Transaction > Receipt & Payment > Receipt', 'Receipt', 'Happy path', true, LOGIN, ['Create a receipt voucher', 'Pass it from Pass Transactions', 'Open Day Book'], '2500', 'Debit equals credit; appears in Day Book and Cash Book.');
T('Transactions', 'Transaction > Journal / Transfer Entry', 'Journal / Transfer Entry', 'Negative', true, LOGIN, ['Enter debit 1000 and credit 900', 'Save'], '1000 / 900', 'Refused: debit must equal credit.');
T('Transactions', 'Transaction > Journal / Transfer Entry', 'Journal / Transfer Entry', 'Happy path', true, LOGIN, ['Enter balanced debit and credit 1000', 'Save', 'Pass', 'Print Journal/Transfer Voucher'], '1000', 'Posted; printed voucher shows both sides.');
T('Transactions', 'Transaction > Pass Transactions', 'Pass Transactions', 'Edge', true, 'A pending voucher', ['Pass it', 'Try to pass the same voucher again (second tab / refresh)'], '-', 'Second attempt refused; ledger has one set of entries.');
T('Transactions', 'Transaction > Pass Transactions', 'Reverse voucher', 'Happy path', false, 'A passed TEST voucher', ['Reverse that voucher', 'Check ledger'], '-', 'Reversal entry created; totals net to zero.');
T('Transactions', 'Transaction > Member Balance Transfer', 'Member Balance Transfer', 'Happy path', true, 'Two test members', ['Transfer 500 from member A to B'], '500', 'A decreases, B increases, one voucher; more than A\'s balance is refused.');
T('Transactions', 'Transaction > Demand / Recovery List > Import Demand List', 'Import Demand List', 'Happy path', true, 'Demand Excel for test members', ['Import preview', 'Check flagged rows', 'Process import'], 'sample demand file', 'Preview shows mismatched EMI flags; process posts to loan ledgers once; re-import is refused or does not double-post.');
T('Transactions', 'Transaction > Demand / Recovery List > Generate', 'Demand Generate', 'Regression', true, 'Division / Wing selected', ['Generate for one wing and one month', 'Open Print Members Demand List'], '-', 'List respects the filters; amounts match loan schedules.');
T('Transactions', 'Transaction > Demand / Recovery List > Modify Short Recovery', 'Short Recovery', 'Regression', false, 'Short recovery case', ['Adjust the short amount'], '-', 'Adjustment visible in the next month\'s demand.');
T('Transactions', 'Administration > DayEnd', 'Day End', 'Happy path', true, 'Test database / date only', ['Run Day End for the date', 'Run it a second time for the same date'], '-', 'First run succeeds; second run is refused or harmless; no duplicate postings; cash book totals unchanged.');
T('Transactions', 'Administration > DayEnd', 'Day End - parallel', 'Edge', true, 'Two PCs', ['Start Day End on both at the same moment'], '-', 'Only one runs; the other is told to wait.');
T('Transactions', 'Administration > Financial Year', 'Financial Year steps 1-4', 'Regression', true, 'COPY of database only', ['Run steps 1-4 in order', 'Check opening balances of the new year'], '-', 'Closing balances equal opening balances; P&L transferred once. Never run on live data without a backup.');
T('Transactions', 'Administration > Interest Calculation', 'Interest Calculation / Posting', 'Happy path', true, 'Test data', ['Calculate SB interest for a period', 'Compare with Premature Information'], '-', 'Interest equals hand calculation; posting twice for the same period is refused.');
T('Transactions', 'Administration > Dividend Calculation / Credit', 'Dividend', 'Happy path', true, 'Test members with shares', ['Calculate dividend', 'Credit dividend', 'Open Dividend Report'], '-', 'Report total equals credit total; second credit run refused.');

// ---------------------------------------------------------------- 6. Utilities & admin
T('Admin', 'Utility > Database BackUp', 'Database BackUp', 'Happy path', true, 'Administrator', ['Open Database BackUp', 'Take a backup', 'Open the list', 'Verify the backup file'], '-', 'New file appears with size > 0; list opens within a few seconds (known slow ES-263); verify says OK. Do NOT restore or delete real backups.');
T('Admin', 'Administration > Modify Business Rules', 'Business Rules', 'Regression', true, 'Administrator', ['Open rules', 'Note a value', 'Change it and Save', 'Reopen; set it back'], '-', 'Value persists after reopen; loan screens use the new value.');
T('Admin', 'Administration > Deposite/Loan Slab', 'Deposit/Loan Slab', 'Regression', false, 'Administrator', ['Add a test slab', 'Edit it', 'Check no other slab changed'], '-', 'Only the edited slab changes.');
T('Admin', 'Administration > Head Addition / Modification', 'Head Master', 'Regression', false, 'Administrator', ['Add head QA HEAD', 'Check it in the voucher head dropdown'], '-', 'Available in dropdowns.');
T('Admin', 'Utility > Communication Hub / Notification Centre', 'Communication Hub', 'Happy path', false, 'Test member with phone', ['Compose a test message to ONE test member', 'Send', 'Check status'], '-', 'Status becomes Sent or Failed with a reason; Retry works.');
T('Admin', 'Utility > Support Desk', 'Support Desk', 'Happy path', false, LOGIN, ['Raise a test query', 'Check Jira (SPT)'], 'Subject: QA test, ignore', 'Ticket appears in Jira and Telegram.');
T('Admin', 'Settings', 'Settings / Dark mode', 'Regression', false, LOGIN, ['Switch dark mode', 'Open 5 different windows'], '-', 'All text readable; no white boxes.');
T('Admin', 'Help', 'About / Replay Tour', 'Happy path', false, LOGIN, ['Open About', 'Replay Tour'], '-', 'Version shown; tour runs.');
T('Admin', 'Start-up', 'Backend offline', 'Negative', true, 'Stop the backend', ['Open the app', 'Try to login'], '-', 'Friendly "cannot reach server" message; recovers when backend is back.');
T('Admin', 'Start-up', 'License', 'Regression', true, 'Test machine', ['Start with a valid licence', 'Start with an expired test licence'], '-', 'Valid: opens. Expired: grace/lock message as designed.');
T('Admin', 'Logs', 'Log files', 'Regression', true, 'Backend logs folder', ['Login, make one wrong login, open one report', 'Check logs folder for today\'s entries'], '-', 'Today\'s files exist (combined, error, http-access, audit, auth). Currently fails - ES-261.');

// ---------------------------------------------------------------- 7. Reports (generated for every report window)
const reports = [
  ['1.1 Cash-Book (Receiptwise Rough)', 'Reports > 1. Daily'], ['1.2 Cash-Book', 'Reports > 1. Daily'], ['1.3 Day-Book', 'Reports > 1. Daily'], ['1.4 Day-Book [CD]', 'Reports > 1. Daily'], ['1.5 Consolidation Of Daily A/c', 'Reports > 1. Daily'],
  ['2. Member Ledger Report', 'Reports'], ['3. General Ledger', 'Reports'], ['4.1.1 Receipt/Payment Voucher', 'Reports > 4. Monthly > 4.1 Print Vouchers'], ['4.1.2 Journal/Transfer Voucher', 'Reports > 4. Monthly > 4.1 Print Vouchers'],
  ['4.2 Cash Book Monthly', 'Reports > 4. Monthly'], ['4.3 Detail Ledger', 'Reports > 4. Monthly'], ['4.4 Bank Detail Ledger', 'Reports > 4. Monthly'], ['4.5 Defaulter List', 'Reports > 4. Monthly'], ['4.6 New Loan Disbursed', 'Reports > 4. Monthly'], ['4.7 Member Loan Ledger', 'Reports > 4. Monthly'], ['4.8 Loan Account Statement', 'Reports > 4. Monthly'],
  ['5.1 P & L / Balance Sheet', 'Reports > 5. Yearly'], ['5.2.1 Voters/Withdrawl List', 'Reports > 5. Yearly > 5.2'], ['5.3.1 Dividend Report', 'Reports > 5. Yearly > 5.3'], ['5.3.2 Dividend Paid', 'Reports > 5. Yearly > 5.3'], ['5.3.3 Int. List CD/MD/SHRt', 'Reports > 5. Yearly > 5.3'], ['5.3.4 Dividend Warrant', 'Reports > 5. Yearly > 5.3'],
  ['5.5 Member Loan Detail', 'Reports > 5. Yearly'], ['5.6 Share Warrent Printing', 'Reports > 5. Yearly'], ['5.7 Annual Member Statement', 'Reports > 5. Yearly'], ['5.8 Yearly Member Statement', 'Reports > 5. Yearly'], ['5.9 Member Ledger', 'Reports > 5. Yearly'], ['5.10 Member Statement', 'Reports > 5. Yearly'],
  ['6. Member Detail Ledger', 'Reports'], ['8. Account Balance', 'Reports'], ['9.1 Saving Statement', 'Reports > 9. Member Statement'], ['9.2 RD Statement', 'Reports > 9. Member Statement'], ['9.4 Member Statement', 'Reports > 9. Member Statement'], ['9.5 New Share Certificate', 'Reports > 9. Member Statement'], ['9.6 Interest Certificate', 'Reports > 9. Member Statement'], ['9.7 Loan Nil Certificate', 'Reports > 9. Member Statement'],
  ['10. Surety Register', 'Reports'], ['11. Deposit Due Date Register', 'Reports'], ['12.1 Account Closing Register', 'Reports > 12. Account Reports'], ['12.3 Share Certificate', 'Reports > 12. Account Reports'], ['12.4 Recurring Details', 'Reports > 12. Account Reports'], ['12.5 Recovery Details', 'Reports > 12. Account Reports'], ['12.6 Loan Contributions Register', 'Reports > 12. Account Reports'], ['12.7 Lien Account Information', 'Reports > 12. Account Reports'], ['12.8 Loan Consolidation Chain', 'Reports > 12. Account Reports'], ['12.9 Loan Re-agreement History', 'Reports > 12. Account Reports'],
  ['13. Pass Book Printing', 'Reports'], ['14. Report Head Order', 'Reports'], ['Report Pro - Legacy Report Workspace', 'Reports > Report Pro'],
];
const REPORT_BLOCKERS = /Cash-Book|Day-Book|General Ledger|Member Ledger|Loan Account Statement|Balance Sheet|Loan Ledger|Defaulter|New Loan/;
for (const [name, menu] of reports) {
  const blk = REPORT_BLOCKERS.test(name);
  T('Reports', menu, name, 'Happy path', blk, LOGIN + '; data exists for the chosen period', ['Open the report', 'Choose a date/month/member that HAS data (e.g. a month with vouchers)', 'Click Show / View'], 'e.g. current month; member 9999962386', 'Report appears within 10 seconds; columns filled; no "undefined", NaN or blank rows.');
  T('Reports', menu, name, 'Accuracy', blk, 'Same', ['Pick 3 rows or totals from the report', 'Compare with the source screen (voucher / ledger / loan statement)'], 'any 3 figures', 'Figures match exactly (to the paisa). Totals equal the sum of the lines.');
  T('Reports', menu, name, 'Edge', false, 'Same', ['Choose a period with NO data', 'Choose From date later than To date', 'Leave a required filter empty'], 'future month; 31-12 to 01-01', 'Friendly "no data" or validation message; no error page, no endless spinner.');
  T('Reports', menu, name, 'Print', false, 'Same', ['Click Print / Preview', 'Compare with the legacy printed layout'], '-', 'Monospace letterhead layout (as legacy), page breaks sensible, nothing cut off.');
}

// ---------------------------------------------------------------- Release gate
const gate = rows.filter(r => r['Release Blocker'] === 'YES').map(r => ({ ID: r.ID, Module: r.Module, Window: r.Window, Type: r.Type, Scenario: r['Steps (do this)'].split('\n')[0].replace(/^1\. /, ''), 'Result (Pass/Fail)': '', 'Defect ID (Jira)': '' }));

const readme = [
  ['Manual Regression Test Plan - Loan Management System'], [''],
  ['Purpose', 'Run this before every release. Core money flows (Loan, Deposits, Vouchers, Day End, Security) must never break.'],
  ['How to use', '1) Open "Release Gate": every row there MUST pass before release.  2) Use "Test Cases" for the full list - filter by Module or Menu Path.  3) Write Pass or Fail, your name and date.  4) For every Fail create a Jira Bug (project ES) and put its number in "Defect ID".'],
  ['Test data rule', 'Use TEST members and TEST users only. NEVER delete or change real members, users, loans or backups. To test a delete, first create a throwaway record (name it QA DELETE ME / QA_TMP_x) and delete only that.'],
  ['When to run what', 'Any change: Release Gate. Change in a module: all cases of that Module + Release Gate. Release candidate: everything.'],
  ['Passing rule', 'A case passes only if the Expected Result is fully true. If unsure, mark Fail and add a note.'],
  ['Known open issues (Jira ES, 2026-10-16)', 'Release blockers: ES-315 Saving receipt/payment cannot save; ES-321 parallel loan repayments lose updates; ES-322 early closure accepts free waiver; ES-323 Compulsory Deposit cannot post. High: ES-258 own-account delete, ES-261 logs not written, ES-267 balance sheet exhausts DB pool, ES-316/317/318/319/320 loan application, sanction, disbursement and repayment validation, ES-309/313 missing input validation on members and vouchers, ES-325 masters overwrite on duplicate key. Medium/low: ES-259/262/314 500 instead of 4xx, ES-263/264 slow screens, ES-265 EMI calculator validation, ES-268 rate limiting off, ES-310/311/312 member screens, ES-326, ES-324.'],
  ['Generated', new Date().toISOString().slice(0, 10) + ' from the QA suite; ' + rows.length + ' cases, ' + gate.length + ' release blockers'],
];
const testData = [
  { Item: 'Test login (admin level)', Value: 'QA_USER_Test (password kept by the QA lead - do not paste into tickets)', Note: 'Created for testing only' },
  { Item: 'Test members', Value: '9999962386 - 9999962395 (SLOTMATRIX set)', Note: 'Backdated in Member Ledger for slot/consolidation checks' },
  { Item: 'Sample loan case', Value: 'Use "Loan Application" to create your own and note the case number', Note: 'Do not reuse real case numbers' },
  { Item: 'EMI check value', Value: '100000 @ 12% for 12 months = EMI 8884.88, total interest 6618.55', Note: 'Verified against backend' },
  { Item: 'Throwaway names', Value: 'QA_TMP_<n>, QA DELETE ME, QA WING, QA HEAD', Note: 'Only these may be deleted during tests' },
];
const windows = [];
(function collect() {
  const nav = fs.readFileSync(path.resolve(__dirname, '../../../Frontend/src/components/navigation/Navbar.tsx'), 'utf8');
  const seen = new Set();
  for (const m of nav.matchAll(/\{ title: '([^']+)', (?:shortcut: '[^']*', )?action: '([A-Z_0-9a-z]+)'/g)) {
    if (seen.has(m[2])) continue; seen.add(m[2]);
    const count = rows.filter(r => r.Window.toLowerCase().includes(m[1].toLowerCase().replace(/^[\d.]+\s*/, '').slice(0, 12))).length;
    windows.push({ 'Menu item': m[1], Action: m[2], 'Test cases': count || '', 'Coverage': count ? 'Covered' : 'Smoke only: open, fill valid data, one invalid entry, save, reopen' });
  }
})();
const bug = [{ 'Bug ID': '', 'Test Case': '', 'Window': '', 'What happened': '', 'What should happen': '', 'Screenshot file': '', 'Reported by': '', 'Date': '', 'Jira key': '' }];
const run = [{ 'Release / Build': '', 'Date': '', 'Tester': '', 'Release Gate passed (Y/N)': '', 'Cases run': '', 'Cases failed': '', 'Sign-off': '' }];

const wb = XLSX.utils.book_new();
const add = (name, data, widths, isAoa) => {
  const ws = isAoa ? XLSX.utils.aoa_to_sheet(data) : XLSX.utils.json_to_sheet(data);
  ws['!cols'] = widths.map(w => ({ wch: w }));
  if (!isAoa && data.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length, c: Object.keys(data[0]).length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws, name);
};
add('How To Use', readme, [22, 130], true);
add('Release Gate', gate, [9, 14, 36, 12, 70, 18, 18]);
add('Test Cases', rows, [9, 9, 13, 38, 30, 12, 34, 70, 30, 60, 14, 12, 12, 14, 24]);
add('Window Index', windows, [48, 38, 11, 60]);
add('Test Data', testData, [26, 70, 52]);
add('Bug Log', bug, [10, 12, 24, 44, 44, 22, 16, 12, 12]);
add('Run Sheet', run, [18, 12, 16, 22, 12, 14, 16]);
const out = path.resolve(__dirname, '../../../docs/final-documentation/qa');
fs.mkdirSync(out, { recursive: true });
XLSX.writeFile(wb, path.join(out, 'Manual_Regression_Test_Plan.xlsx'));
console.log('written', rows.length, 'cases;', gate.length, 'release blockers;', windows.length, 'menu items');
