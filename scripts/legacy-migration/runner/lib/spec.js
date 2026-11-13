'use strict';
// The run sheet (migration-v1.md section 44) as data. Reference counts ("dump") come from the 03-Nov-2026 dump
// and are INFORMATIONAL: the final run is checked against its own baseline measured on the frozen dump.

/**
 * Copy tables. order: 'key:<column>' (unique key, keyset paging) or 'physloc' (physical row locator, stable on a
 * frozen database). sums: legacy money columns summed on both sides. member: member-number column (orphan report).
 * constants: target-only (new-feature) columns set explicitly to the app default decided in the section named.
 * insertMissingBy: natural key for "insert only what is missing" (tables that may come with seeded rows).
 */
const COPY_TABLES = [
  // step 1 (section 42.1, 40, 41; Q71, Q72, Q74)
  { id: 'castcategorymaster', legacy: 'castcategorymaster', step: 1, section: '40', dump: 4, order: 'physloc' },
  { id: 'headtype', legacy: 'headtype', step: 1, section: '42.1', dump: 20, order: 'physloc' },
  { id: 'society_details', legacy: 'society_details', step: 1, section: '42.1', dump: 1, order: 'physloc' },
  { id: 'wingmast', legacy: 'wingmast', step: 1, section: '42.1', dump: 1, order: 'physloc' },
  { id: 'division_master', legacy: 'division_master', step: 1, section: '42.1', dump: 6, order: 'physloc' },
  { id: 'membertypemaster', legacy: 'membertypemaster', step: 1, section: '42.1', dump: 4, order: 'physloc' },
  { id: 'parameter_setting', legacy: 'parameter_setting', step: 1, section: '42.1', dump: 11, order: 'physloc' },
  { id: 'crybsnew', legacy: 'crybsnew', step: 1, section: '42.1', dump: 105, order: 'physloc' },
  { id: 'crplhor1', legacy: 'crplhor1', step: 1, section: '42.1', dump: 41, order: 'physloc' },
  { id: 'bank_passbook_page_setting', legacy: 'bank_passbook_page_setting', step: 1, section: '42.1', dump: 2, order: 'physloc' },
  { id: 'demandprintorder', legacy: 'demandprintorder', step: 1, section: '41', dump: 6, order: 'physloc' },
  // step 2 (section 32; Q57): transform in lib/steps.js (PFLAG), seeded I1013/I1014 kept
  { id: 'headmaster', legacy: 'headmaster', step: 2, section: '32', dump: 151, order: 'physloc', sums: ['OP_BAL'], insertMissingBy: ['code'], allowSeeded: { code: ['I1013', 'I1014'] } },
  // step 3 (sections 33, 34, 35, 36, 42.2)
  { id: 'yearend', legacy: 'yearend', step: 3, section: '33', dump: 8, order: 'physloc' },
  { id: 'getworkingdate', legacy: 'getworkingdate', step: 3, section: '34', dump: 2358, order: 'physloc' },
  { id: 'bankopbal', legacy: 'bankopbal', step: 3, section: '36', dump: 130, order: 'physloc', sums: ['ClosingBalance'] },
  { id: 'voucher_master', legacy: 'voucher_master', step: 3, section: '35', dump: 1, order: 'physloc' },
  { id: 'busrules', legacy: 'busrules', step: 3, section: '42.2', dump: 4025, order: 'key:SRNO' },
  // step 5 (section 11, 13): derived columns added by lib/steps.js
  { id: 'member_master', legacy: 'member_master', step: 5, section: '11, 13', dump: 7312, order: 'physloc', member: 'MBNO', constants: { share_amount: 0, compulsory_deposit: 0 } },
  // step 6 (sections 16, 17, 18, 38)
  { id: 'membercategory', legacy: 'membercategory', step: 6, section: '16', dump: 7323, order: 'physloc', member: 'MBNO' },
  { id: 'fundsmaster', legacy: 'fundsmaster', step: 6, section: '17', dump: 7313, order: 'physloc', member: 'MBNO', sums: ['SHAREOPBAL', 'CDOPBAL', 'MDOPBAL', 'MD1_OPBAL'] },
  { id: 'frs', legacy: 'frs', step: 6, section: '18', dump: 6454, order: 'physloc', member: 'MBNO', sums: ['FRS', 'FRS_FUND'] },
  { id: 'frs_balance', legacy: 'frs_balance', step: 6, section: '18', dump: 6735, order: 'physloc', member: 'Mbno', sums: ['Balance'] },
  { id: 'suretymaster', legacy: 'suretymaster', step: 6, section: '38', dump: 6, order: 'physloc', member: 'mbno', sums: ['Amount'] },
  // step 7 (section 23, 24)
  { id: 'ledger', legacy: 'ledger', step: 7, section: '23', dump: 1597229, order: 'key:LedgerId', member: 'MBNO', sums: ['TRANS_AMT'], batch: 25000, orderedHash: true },
  { id: 'ledger_data', legacy: 'ledger_data', step: 7, section: '24', dump: 4733, order: 'physloc', member: 'MBNO' },
  // step 8 (sections 26-30)
  { id: 'loan_master', legacy: 'loan_master', step: 8, section: '27', dump: 20207, order: 'physloc', member: 'MBNO', sums: ['LOAN_AMT'],
    constants: { gracedays: 0, smpenalpct: 1, smpenaldiv: 4, loan_payment_model: 'SEPARATE_INTEREST', loan_interest_method: 'REDUCING_BALANCE' } },
  { id: 'loan_pending', legacy: 'loan_pending', step: 8, section: '29', dump: 19217, order: 'physloc', member: 'MBNO', sums: ['SANCTIONED_AMT'],
    constants: { application_kind: 'NEW', pass_flag: 'N' } },
  { id: 'loan_masterhistory', legacy: 'loan_masterhistory', step: 8, section: '28', dump: 13867, order: 'physloc', member: 'MBNO', sums: ['LOAN_AMT'] },
  { id: 'loan_product', legacy: 'loan_product', step: 8, section: '26', dump: 10543, order: 'physloc', member: 'MBNo', sums: ['Interest'] },
  { id: 'loan_balance_history', legacy: 'loan_balance_history', step: 8, section: '30', dump: 189011, order: 'physloc', member: 'mbno', sums: ['balance'] },
  // step 9 (sections 20, 21, 22, 41)
  { id: 'demand_master', legacy: 'demand_master', step: 9, section: '21', dump: 333877, order: 'physloc', member: 'MBNO', sums: ['TotalDemand'], batch: 20000 },
  { id: 'demand_masterdelete', legacy: 'demand_masterdelete', step: 9, section: '22', dump: 572163, order: 'physloc', member: 'MBNO', sums: ['TotalDemand'], batch: 20000 },
  { id: 'demand_receipt', legacy: 'demand_receipt', step: 9, section: '41', dump: 11, order: 'physloc', member: 'MBNO', sums: ['TRANS_AMT'] },
  { id: 'bank_cheq_master', legacy: 'bank_cheq_master', step: 9, section: '20', dump: 21555, order: 'physloc', member: 'MBNO', sums: ['CHEQAMT'] },
];

const byId = Object.fromEntries(COPY_TABLES.map(t => [t.id, t]));

/** The 15 steps of section 44.2, each mapped to its sections. kind tells the engine what to run. */
const STEPS = [
  { no: 1, title: 'Reference tables: exact copy, insert missing only', sections: '42.1, 40, 41 (Q71, Q72, Q74)', kind: 'copy', tables: COPY_TABLES.filter(t => t.step === 1).map(t => t.id), stops: 'yes, if a row differs' },
  { no: 2, title: 'headmaster (151 + I1013/I1014), 6 blank PFLAG set to A', sections: '32 (Q57, Q58)', kind: 'copy', tables: ['headmaster'], stops: 'yes, if a ledger code is missing or OP_BAL differs' },
  { no: 3, title: 'yearend, getworkingdate, bankopbal, voucher_master, busrules (+ go-live row)', sections: '33, 34, 35, 36, 42.2 (Q59, Q61, Q63, Q64, Q75)', kind: 'copy+busrules', tables: ['yearend', 'getworkingdate', 'bankopbal', 'voucher_master', 'busrules'], stops: 'yes' },
  { no: 4, title: 'office_master / wing_master derived, designation_master empty', sections: '43.3 (Q78)', kind: 'derive-masters', tables: ['office_master', 'wing_master'], stops: 'yes' },
  { no: 5, title: 'member_master (insert only, full_name + cast_category computed)', sections: '11, 13 (Q25, Q26, Q79)', kind: 'copy', tables: ['member_master'], stops: 'yes, if a member is missing or a legacy column differs' },
  { no: 6, title: 'membercategory, fundsmaster, frs, frs_balance, suretymaster', sections: '16, 17, 18, 38 (Q30, Q33, Q35, Q67)', kind: 'copy', tables: ['membercategory', 'fundsmaster', 'frs', 'frs_balance', 'suretymaster'], stops: 'yes' },
  { no: 7, title: 'ledger (whole table, ids kept) and ledger_data', sections: '23, 24 (Q44, Q46)', kind: 'copy', tables: ['ledger', 'ledger_data'], stops: 'yes' },
  { no: 8, title: 'loan_master, loan_pending, loan_masterhistory, loan_product, loan_balance_history', sections: '26-30 (Q47-Q53)', kind: 'copy', tables: ['loan_master', 'loan_pending', 'loan_masterhistory', 'loan_product', 'loan_balance_history'], stops: 'yes' },
  { no: 9, title: 'demand_master, demand_masterdelete, demand_receipt, bank_cheq_master', sections: '20, 21, 22, 41 (Q40-Q43, Q72)', kind: 'copy', tables: ['demand_master', 'demand_masterdelete', 'demand_receipt', 'bank_cheq_master'], stops: 'yes' },
  { no: 10, title: 'member_balances derived by head code (L1001, L1004; FRS L1002 + L1045)', sections: '19 (Q37, Q38, Q39)', kind: 'derive-member-balances', tables: ['member_balances'], stops: 'yes, if outside tolerance' },
  { no: 11, title: 'share_monthly_balance backfill (month-ends Nov 2019 to last month)', sections: '43.3 (Q77)', kind: 'derive-share-monthly', tables: ['share_monthly_balance'], stops: 'yes' },
  { no: 12, title: 'tblcashbook: rows by the proven Cash Book rule + opening row 31-Oct-2019', sections: '39.7 (Q68, Q69, Q70)', kind: 'derive-cashbook', tables: ['tblcashbook'], stops: 'yes' },
  { no: 13, title: 'Counters: sequence_master and voucher_master never below the ledger', sections: '35.4, 29.4, B20 (Q63)', kind: 'counters', tables: ['sequence_master', 'voucher_master'], stops: 'yes' },
  { no: 14, title: 'Phase 2 loan replay: equality check, dry run, real run in batches', sections: '31 (Q54, Q55, Q56)', kind: 'phase2', tables: ['loan_master', 'loan_repayment_ledger'], stops: 'only failed / LEDGER_MISMATCH_AFTER_REPLAY / LEDGER_OWES_NO_OPEN_CASE' },
  { no: 15, title: 'Post-load verification suite and the review report', sections: '44.3', kind: 'verify', tables: [], stops: 'all checks must pass before go-live' },
];

/** Tables in 43.2 that the migration (or Phase 2) fills, so they must be empty before the run. */
const GROUP_DERIVED = ['office_master', 'wing_master', 'designation_master', 'share_monthly_balance', 'tblcashbook', 'member_balances'];
const GROUP_PHASE2 = ['loan_repayment_ledger', 'loan_schedule_versions', 'loan_rb_schedule', 'loan_payment_flags', 'legacy_replay_batch_log', 'loan_reagreements', 'loan_reagreement_documents', 'loan_reagreement_log'];
/** group 5 (runtime logs and test data) and group 6 (users) of 43.2: must be empty in the template. */
const GROUP_RUNTIME = ['backup_log', 'ai_chat_logs', 'day_end_processes', 'dividend_master', 'fdmaster', 'fd_nominee', 'loan_nominee', 'sbmaster', 'interestpaid',
  'notification_logs', 'support_queries', 'system_notifications', 'system_notification_reads', 'terms_acceptances', 'twofa_audit', 'revoked_tokens', 'onboarding_progress',
  'user_onboarding', 'user_preferences', 'user_recovery_codes', 'transactions', 'vouchers', 'yearend_member', 'yearend_head', 'member_funds_audit', 'member_dor_backup_es99',
  'mobile_audit_log', 'report_schedule_header', 'license_keys', 'loan_monthly_balance'];
const GROUP_USERS = ['usermaster', 'userrights', 'userleveldefaultrights', 'userinfo', 'logintime'];
/** group 4 (43.2): app configuration the template keeps. Rows allowed. Anything else with rows blocks the run. */
const CONFIG_TABLES = ['menumaster', 'userlevelmaster', 'system_configs', 'system_settings', 'alert_settings', 'mobile_setting', 'mobile_feature_flag', 'mobile_app_version',
  'report_head_order', 'head_master', 'bank_saving_detail_product', 'interestmaster', 'interest_rates', 'migrations', 'sequence_master'];
/** Tables the run itself is allowed to find non-empty at the start (seeded rows only, listed per table). */
const SEEDED_ALLOWED = { headmaster: { column: 'code', values: ['I1013', 'I1014'] } };

/** Counter targets (44.2 step 13, B20). */
const LOAN_HEADS = { RLN: 'A1002', ALN: 'A1047', ELN: 'A1047' };

/** Cash Book printouts proven in 39.7 (receipt cash, receipt transfer, payment cash, payment transfer), whole-date totals. */
const CASHBOOK_PROOF = {
  '2019-11-01': { rcash: '188722', rtransfer: '1251446', pcash: '60530', ptransfer: '1234356' },
  '2023-03-31': { rcash: '251583', rtransfer: '47194650', pcash: '12229', ptransfer: '47194650' },
  '2026-10-09': { rcash: '49975', rtransfer: '11950119', pcash: '304352', ptransfer: '11950119' },
};

const PHASE2_BLOCKING_FLAGS = ['LEDGER_MISMATCH_AFTER_REPLAY', 'LEDGER_OWES_NO_OPEN_CASE'];

module.exports = { COPY_TABLES, byId, STEPS, GROUP_DERIVED, GROUP_PHASE2, GROUP_RUNTIME, GROUP_USERS, CONFIG_TABLES, SEEDED_ALLOWED, LOAN_HEADS, CASHBOOK_PROOF, PHASE2_BLOCKING_FLAGS };
