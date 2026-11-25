// The windows the client can set to "working date" or "system date" (Day End > Date settings).
// The key is the window's menu action code. A window with no saved setting uses the WORKING date.
//
// `wired` says whether the window's code already takes its date from resolvePostingDate(). It is shown on the settings
// screen: a window that is not wired yet cannot be switched (its setting would change nothing) until it is connected.
// Keep it true ONLY for a window that really calls resolvePostingDate with this key.
export interface DatePolicyWindow {
    key: string;
    label: string;
    /** Menu area, for grouping on the screen */
    area: string;
    /** posts = writes money lines to the ledger / cash book; stores = stores a date only */
    kind: 'posts' | 'stores';
    wired: boolean;
}

export const DATE_POLICY_WINDOWS: DatePolicyWindow[] = [
    // Receipt & Payment
    { key: 'RECEIPT_PAYMENT', label: 'Receipt (Receipt / General / Demand)', area: 'Receipt & Payment', kind: 'posts', wired: true },
    { key: 'RECEIPT_PAYMENT_VOUCHER_CREATION', label: 'Payment Voucher Creation', area: 'Receipt & Payment', kind: 'posts', wired: true },
    { key: 'JOURNAL_TRANSFER_ENTRY', label: 'Journal / Transfer Entry', area: 'Transaction', kind: 'posts', wired: true },
    // Security
    { key: 'USER_MANAGEMENT', label: 'Create / Modify Users (creation and enable / disable date)', area: 'Security', kind: 'stores', wired: true },
    { key: 'LOGOUT_USER', label: 'Sign-in / Logout User (login date of a session)', area: 'Security', kind: 'stores', wired: true },
    // Loans
    { key: 'LOAN_APP', label: 'Loan Application (application date)', area: 'Loan', kind: 'stores', wired: true },
    { key: 'LOAN_PAYMENT', label: 'Loan Payment (disbursement)', area: 'Loan', kind: 'posts', wired: false },
    { key: 'LOAN_REPAYMENT', label: 'NR Repayment', area: 'Loan', kind: 'posts', wired: false },
    { key: 'LOAN_EARLY_CLOSURE', label: 'Loan Early Closure', area: 'Loan', kind: 'posts', wired: false },
    { key: 'LOAN_REAGREEMENT', label: 'Loan Re-agreement', area: 'Loan', kind: 'posts', wired: false },
    // Deposits and transfers
    { key: 'COMPULSORY_DEPOSIT_TRANSACTION', label: 'RD/CD Transaction', area: 'Deposits', kind: 'posts', wired: false },
    { key: 'COMPULSORY_DEPOSIT_LEGACY', label: 'RD/CD Transaction Legacy', area: 'Deposits', kind: 'posts', wired: false },
    { key: 'MEMBER_BALANCE_TRANSFER', label: 'Member Balance Transfer', area: 'Deposits', kind: 'posts', wired: false },
    { key: 'SAVING_AC_OPENING', label: 'Saving A/c Opening', area: 'Deposits', kind: 'stores', wired: false },
    { key: 'SAVING_RECEIPT_PAYMENT', label: 'Saving [Receipt -- Payment]', area: 'Deposits', kind: 'posts', wired: false },
    { key: 'RD_MEMBER_SETUP', label: 'RD/CD Member Setup', area: 'Deposits', kind: 'posts', wired: false },
    { key: 'RD_WITHDRAWAL', label: 'RD/CD Withdrawal', area: 'Deposits', kind: 'posts', wired: false },
    { key: 'RD_REPAYMENT', label: 'RD/CD Repayment', area: 'Deposits', kind: 'posts', wired: false },
    // Demand / recovery
    { key: 'IMPORT_DEMAND_LIST', label: 'Import Demand List', area: 'Demand / Recovery', kind: 'posts', wired: false },
    { key: 'GENERATE', label: 'Demand Generate', area: 'Demand / Recovery', kind: 'posts', wired: false },
    { key: 'UPDATION_LEDGER_POSTING', label: 'Demand Updation / Ledger Posting', area: 'Demand / Recovery', kind: 'posts', wired: false },
    // Interest, insurance, year end
    { key: 'INTEREST_CALC_POST', label: 'Interest Calculation / Posting', area: 'Year end', kind: 'posts', wired: false },
    { key: 'GROUP_INSURANCE', label: 'Group Insurance', area: 'Year end', kind: 'posts', wired: false },
    { key: 'RD_FY_CLOSING', label: 'RD/CD Financial Year Closing', area: 'Year end', kind: 'posts', wired: false },
    { key: 'FIN_YEAR_TRANSFER', label: 'Financial Year: Transfer Entries For Closing', area: 'Year end', kind: 'posts', wired: false },
    { key: 'FIN_YEAR_CLOSING', label: 'Financial Year Closing', area: 'Year end', kind: 'posts', wired: false },
    { key: 'FIN_YEAR_BALANCE_TRANSFER', label: 'Financial Year: Balance Transfer', area: 'Year end', kind: 'posts', wired: false },
    { key: 'FIN_YEAR_PL_PROCESS', label: 'Financial Year: P and L Year End Process', area: 'Year end', kind: 'posts', wired: false },
];

export const DATE_POLICY_KEYS: ReadonlySet<string> = new Set(DATE_POLICY_WINDOWS.map((w) => w.key));

export const DATE_POLICY_FILE_FORMAT = 'espat-date-policy';
export const DATE_POLICY_FILE_VERSION = 1;
