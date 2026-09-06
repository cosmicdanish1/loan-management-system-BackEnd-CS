// Maps each frontend Navbar `action` code (Frontend/src/components/navigation/Navbar.tsx)
// to the legacy `menumaster.menuid` that Configure UserLevel Default Rights
// (Role Management) grants/revokes rights against. This is the missing link that
// makes menu-rights configured on that screen actually restrict what a user sees —
// previously nothing in the app ever read menuid -> action, so the whole
// userrights/userleveldefaultrights system had no observable effect.
//
// Entries below menuid 201 matched an existing legacy `menumaster` row by
// description. Entries at 201+ are windows that exist in the modern app but had
// no legacy menu row; seedMenuActionRows() in role-management.service.ts inserts
// them idempotently on boot, the same pattern already used for standardMenus.
//
// Deliberately NOT included (never gated): generic in-window actions with no
// menuid concept (SAVE, CANCEL, DELETE, REFRESH, PRINT, EXIT), and app-chrome
// every user must always reach (SETTINGS, MY_PROFILE). Also excluded:
// DEFINE_TRIAL_BALANCE/OPEN_TRIAL_BALANCE/DEFINE_BALANCE_SHEET/OPEN_BALANCE_SHEET
// (dead serviceMap entries with no route and no navConfig entry).
export interface MenuActionEntry {
  action: string;
  menuid: number;
  title: string;
}

export const MENU_ACTION_MAP: MenuActionEntry[] = [
  // ── Matched to an existing legacy menumaster row ──
  { action: 'LOAN_APP', menuid: 2, title: 'Loan Application' },
  { action: 'CHANGE_LOAN_SURETY', menuid: 67, title: 'Change Loan Surety' },
  { action: 'INTEREST_CALC_POST', menuid: 101, title: 'Interest Calculation / Posting' },
  { action: 'DAY_END', menuid: 68, title: 'DayEnd' },
  { action: 'INTEREST_CALC', menuid: 7, title: 'Interest Calculation' },
  { action: 'DEPOSIT_LOAN_SLAB', menuid: 69, title: 'Deposite/Loan Slab' },
  { action: 'HEAD_ADD_MOD', menuid: 12, title: 'Head Addition / Modification' },
  { action: 'USER_MANAGEMENT', menuid: 13, title: 'Create / Modify Users' },
  { action: 'ROLE_MANAGEMENT', menuid: 14, title: 'Configure UserLevel Default Rights' },
  { action: 'CHANGE_PASSWORD', menuid: 15, title: 'Change Password' },
  { action: 'LOGOUT_USER', menuid: 16, title: 'LogOut User' },
  { action: 'FIN_YEAR_CLOSING', menuid: 63, title: 'Financial Year Closing' },
  { action: 'MODIFY_BIZ_RULES', menuid: 70, title: 'Modify Business Rules' },
  { action: 'DEMAND_PRINT_ORDER', menuid: 72, title: 'Demand Print Order' },
  { action: 'MEMBER_MASTER', menuid: 17, title: 'Member Master' },
  { action: 'RD_AC_OPENING', menuid: 73, title: 'RD A/c Opening' },
  { action: 'PASS_RD_AC', menuid: 74, title: 'Pass RD A/C' },
  { action: 'SAVING_AC_OPENING', menuid: 75, title: 'Saving A/c Opening' },
  { action: 'WING_OFFICE_MASTER', menuid: 18, title: 'Wing / Office Master' },
  { action: 'MODIFY_FD_AC', menuid: 65, title: 'Modify FD A/c' },
  { action: 'MODIFY_MEMBER_BAL', menuid: 76, title: 'Modify Member Balance' },
  { action: 'CAST_CATEGORY', menuid: 200, title: 'Cast Category' },
  { action: 'FD_RD_SB_ENTRY', menuid: 77, title: 'FD/RD/SB Entry' },
  { action: 'RECEIPT_PAYMENT_VOUCHER_CREATION', menuid: 19, title: 'Payment Voucher Creation' },
  { action: 'VOUCHER_PAYMENT', menuid: 22, title: 'Voucher Payment' },
  { action: 'RECEIPT_PAYMENT', menuid: 23, title: 'Receipt' },
  { action: 'RECEIPT_DIVIDEND_PAYMENT', menuid: 8, title: 'Dividend Payment' },
  { action: 'FD_RECEIPT', menuid: 24, title: 'Fixed Deposit Receipt' },
  { action: 'FD_INTEREST_VOUCHER_POSTING', menuid: 20, title: 'FD / Interest Voucher Posting' },
  { action: 'FD_WITHDRAWAL_INT_PAYMENT', menuid: 26, title: 'FD Withdrawal / Int. Payment' },
  { action: 'SAVING_RECEIPT_PAYMENT', menuid: 79, title: 'Saving Receipt Payment' },
  { action: 'JOURNAL_TRANSFER_ENTRY', menuid: 21, title: 'Journal / Transfer Entry' },
  { action: 'LOAN_PAYMENT', menuid: 25, title: 'Loan Payment' },
  { action: 'PASS_TRANSACTIONS', menuid: 1, title: 'Pass Transactions' },
  { action: 'GENERATE', menuid: 4, title: 'Generate Demand' },
  { action: 'UPDATION_LEDGER_POSTING', menuid: 5, title: 'Updation / Ledger Posting' },
  { action: 'PRINT_MEMBERS_DEMAND_LIST', menuid: 59, title: 'Print Members Demand List' },
  { action: 'CHANGE_MEMBER_OFFICE', menuid: 66, title: 'Change Member Office' },
  { action: 'MODIFY_SHORT_RECOVERY', menuid: 81, title: 'Modify Short Recovery' },
  { action: 'CASH_BOOK_RECEIPTWISE', menuid: 48, title: 'Cash Book Receiptwise Rough' },
  { action: 'CASH_BOOK', menuid: 27, title: 'Cash Book' },
  { action: 'DAY_BOOK', menuid: 28, title: 'Day Book' },
  { action: 'DAY_BOOK_SB', menuid: 82, title: 'Day Book SB' },
  { action: 'CONSOLIDATION_DAILY_AC', menuid: 83, title: 'Consolidation Of Daily A/c' },
  { action: 'MEMBER_LEDGER_REPORT', menuid: 29, title: 'Member Ledger Report' },
  { action: 'GENERAL_LEDGER', menuid: 30, title: 'General Ledger' },
  { action: 'RECEIPT_PAYMENT_VOUCHER', menuid: 44, title: 'Receipt/Payment Voucher' },
  { action: 'JOURNAL_TRANSFER_VOUCHER', menuid: 45, title: 'Journal/Transfer Voucher' },
  { action: 'CASH_BOOK_MONTHLY', menuid: 49, title: 'Cash Book Monthly' },
  { action: 'DETAIL_LEDGER', menuid: 54, title: 'Detail Ledger' },
  { action: 'BANK_DETAIL_LEDGER', menuid: 100, title: 'Bank Detail Ledger' },
  { action: 'DEFAULTER_LIST', menuid: 103, title: 'Defaulter List' },
  { action: 'P_L_BALANCE_SHEET', menuid: 32, title: 'P&L / Balance Sheet' },
  { action: 'VOTERS_WITHDRAWL_LIST', menuid: 33, title: 'Voters/Withdrawal List' },
  { action: 'DIVIDEND_REPORT', menuid: 56, title: 'Dividend Report' },
  { action: 'DIVIDEND_PAID', menuid: 57, title: 'Dividend Paid' },
  { action: 'INT_LIST_CD_MD_SHRt', menuid: 102, title: 'Interest List CD/MD/SHRt' },
  { action: 'MEMBER_LOAN_DETAIL', menuid: 62, title: 'Member Loan Detail' },
  { action: 'SHARE_WARRANT_PRINTING', menuid: 86, title: 'Share Warrant Printing' },
  { action: 'MEMBER_DETAIL_LEDGER', menuid: 55, title: 'Member Detail Ledger' },
  { action: 'SAVING_STATEMENT', menuid: 90, title: 'Saving Statement' },
  { action: 'RD_STATEMENT', menuid: 91, title: 'RD Statement' },
  { action: 'FD_STATEMENT', menuid: 92, title: 'FD Statement' },
  { action: 'MEMBER_STATEMENT', menuid: 93, title: 'Member Statement' },
  { action: 'SURETY_REGISTER', menuid: 94, title: 'Surety Register' },
  { action: 'DEPOSIT_DUE_DATE_REGISTER', menuid: 95, title: 'Deposit Due Date Register' },
  { action: 'FIXED_DEPOSIT_CERTIFICATE', menuid: 88, title: 'Fixed Deposit Certificate' },
  { action: 'SHARE_CERTIFICATE', menuid: 89, title: 'Share Certificate' },
  { action: 'PREMATURE_RD_AC', menuid: 96, title: 'Premature Info For RD A/c' },
  { action: 'PREMATURE_SB_AC', menuid: 97, title: 'Premature Info For SB A/c' },
  { action: 'CALCULATOR', menuid: 38, title: 'Calculator' },
  { action: 'FIND', menuid: 39, title: 'Find' },
  { action: 'MEMBER_BALANCE', menuid: 40, title: 'Member Balance' },
  { action: 'EMI_CHART', menuid: 104, title: 'EMI Chart' },
  { action: 'DATABASE_BACKUP', menuid: 58, title: 'Database Backup' },
  { action: 'UPDATE_SAVING_INTT', menuid: 98, title: 'Update Saving Interest' },
  { action: 'INTEREST_RECEIVABLE_RECEIVED_STATEMENT', menuid: 99, title: 'Interest Receivable/Received Statement' },
  { action: 'ABOUT', menuid: 37, title: 'About' },

  // ── No legacy row existed; new ids seeded by seedMenuActionRows() ──
  { action: 'HEAD_OPEN_BAL', menuid: 201, title: 'Head Opening Balance' },
  { action: 'FIN_YEAR_TRANSFER', menuid: 202, title: 'Transfer Entries For Closing' },
  { action: 'FIN_YEAR_BALANCE_TRANSFER', menuid: 203, title: 'Financial Year Balance Transfer' },
  { action: 'SAAKH_SCORE', menuid: 204, title: 'Saakh Score - Member Health' },
  { action: 'CERT_PARAM_SETTING', menuid: 205, title: 'Certificate Parameter Setting' },
  { action: 'FD_CERT_PRINT', menuid: 206, title: 'Fixed Deposit Certificate Printing' },
  { action: 'SHARE_CERT_PRINT', menuid: 207, title: 'Share Certificate Printing' },
  { action: 'PASSBOOK_PARAM_SETTING', menuid: 208, title: 'Passbook Parameter Setting' },
  { action: 'SIGNATURE_SCANNING', menuid: 209, title: 'Signature Scanning' },
  { action: 'DESIGNATION_MASTER', menuid: 210, title: 'Designation Master' },
  { action: 'LOAN_ENTRY', menuid: 211, title: 'Loan Entry' },
  { action: 'LOAN_REPAYMENT', menuid: 212, title: 'Loan Repayment' },
  { action: 'LOAN_EARLY_CLOSURE', menuid: 213, title: 'Loan Early Closure' },
  { action: 'COMPULSORY_DEPOSIT_TRANSACTION', menuid: 214, title: 'Compulsory Deposit Transaction' },
  { action: 'MEMBER_BALANCE_TRANSFER', menuid: 215, title: 'Member Balance Transfer' },
  { action: 'IMPORT_DEMAND_LIST', menuid: 216, title: 'Import Demand List' },
  { action: 'NEW_LOAN_DISBURSED', menuid: 217, title: 'New Loan Disbursed' },
  { action: 'MEMBER_LOAN_LEDGER', menuid: 218, title: 'Member Loan Ledger' },
  { action: 'LOAN_ACCOUNT_STATEMENT', menuid: 219, title: 'Loan Account Statement' },
  { action: 'DIVIDEND_WARRANT', menuid: 220, title: 'Dividend Warrant' },
  { action: 'ANNUAL_MEMBER_STATEMENT', menuid: 221, title: 'Annual Member Statement' },
  { action: 'YEARLY_MEMBER_STATEMENT', menuid: 222, title: 'Yearly Member Statement' },
  { action: 'MEMBER_LEDGER', menuid: 223, title: 'Member Ledger' },
  { action: 'ACCOUNT_BALANCE', menuid: 224, title: 'Account Balance' },
  { action: 'NEW_SHARE_CERTIFICATE', menuid: 225, title: 'New Share Certificate' },
  { action: 'INTEREST_CERTIFICATE', menuid: 226, title: 'Interest Certificate' },
  { action: 'LOAN_NIL_CERTIFICATE', menuid: 227, title: 'Loan Nil Certificate' },
  { action: 'ACCOUNT_CLOSING_REGISTER', menuid: 228, title: 'Account Closing Register' },
  { action: 'RECURRING_DETAILS', menuid: 229, title: 'Recurring Details' },
  { action: 'RECOVERY_DETAILS', menuid: 230, title: 'Recovery Details' },
  { action: 'LOAN_CONTRIBUTIONS_REGISTER', menuid: 231, title: 'Loan Contributions Register' },
  { action: 'LIEN_ACCOUNT_INFORMATION', menuid: 232, title: 'Lien Account Information' },
  { action: 'PASS_BOOK_PRINTING', menuid: 233, title: 'Pass Book Printing' },
  { action: 'COMMUNICATION_HUB', menuid: 234, title: 'Communication Hub' },
  { action: 'CONTENTS', menuid: 235, title: 'Contents' },
  { action: 'FIN_YEAR_PL_PROCESS', menuid: 236, title: 'P and L Year End Process' },
];

export const MENUID_TO_ACTION: ReadonlyMap<number, string> = new Map(
  MENU_ACTION_MAP.map((e) => [e.menuid, e.action]),
);

/** User levels that always see every menu, regardless of configured rights —
 * mirrors the "master bypass" already used by RoleGuard/PermissionsGuard for
 * the 'administrator'/'admin'/'sample_1' roles. SYSTEM is included here too
 * since it is the super-user tier one level above ADMINISTRATOR. */
export const BYPASS_USER_LEVEL_IDS = new Set<number>([0, 1]);
