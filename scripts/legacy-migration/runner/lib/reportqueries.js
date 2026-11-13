'use strict';
// "Report only" lines of the table sections (P1: shown to the society, never block the run), as read-only
// queries on the legacy database. `expected` is the reference number written in migration-v1.md for the
// 03-Nov-2026 dump: informational, a different number on the final dump is normal and is simply reported.
//
// Each entry: { id, table, section, title, expected, from, where, sample }  ->  COUNT_BIG(*) and TOP 50 samples.

// col is qualified with the outer alias t so it cannot bind to member_master inside the sub-select
const NOT_MEMBER = (col) => `NOT EXISTS (SELECT 1 FROM member_master m WHERE m.MBNO = TRY_CAST(t.${col} AS numeric(18,0)))`;

const QUERIES = [
  // member_master (11, 13) / membercategory (16)
  { id: 'dor-differs', table: 'member_master', section: '11.4', title: 'dor differs from date_of_retirement (the trigger keeps date_of_retirement)', expected: 18, from: 'member_master', where: 'DOR IS NOT NULL AND DATE_OF_RETIREMENT IS NOT NULL AND DOR <> DATE_OF_RETIREMENT', sample: "CONVERT(varchar(30),MBNO)+' dor='+CONVERT(varchar(10),DOR,126)+' dor_retire='+CONVERT(varchar(10),DATE_OF_RETIREMENT,126)" },
  { id: 'member-no-category', table: 'member_master', section: '16.2', title: 'members with no membercategory row (cast_category stays empty)', expected: 3, from: 'member_master', where: 'NOT EXISTS (SELECT 1 FROM membercategory c WHERE c.MBNO = member_master.MBNO)', sample: 'CONVERT(varchar(30),MBNO)' },
  { id: 'member-conflicting-category', table: 'member_master', section: '16.2', title: 'members with two different categories (cast_category stays empty)', expected: 1, from: '(SELECT MBNO FROM membercategory GROUP BY MBNO HAVING COUNT(DISTINCT CategoryCode) > 1) q', where: '1=1', sample: 'CONVERT(varchar(30),MBNO)' },
  { id: 'membercategory-orphans', table: 'membercategory', section: '16.2', title: 'category rows whose member is not in member_master', expected: 3, from: 'membercategory t', where: NOT_MEMBER('MBNO'), sample: 'CONVERT(varchar(30),MBNO)' },
  { id: 'membercategory-duplicate-rows', table: 'membercategory', section: '16.2', title: 'identical (member, category, type) rows repeated (groups)', expected: 11, from: '(SELECT MBNO, CategoryCode, MemberType FROM membercategory GROUP BY MBNO, CategoryCode, MemberType HAVING COUNT(*) > 1) q', where: '1=1', sample: 'CONVERT(varchar(30),MBNO)' },
  { id: 'membercategory-not-regular', table: 'membercategory', section: '16.2, Q31', title: 'members whose type is not Regular (the new app shows Regular)', expected: 1, from: 'membercategory', where: 'MemberType <> 1', sample: 'CONVERT(varchar(30),MBNO)' },
  // fundsmaster (17)
  { id: 'funds-orphans', table: 'fundsmaster', section: '17.3', title: 'fund rows with no member', expected: 4, from: 'fundsmaster t', where: NOT_MEMBER('MBNO'), sample: 'CONVERT(varchar(30),MBNO)' },
  { id: 'funds-negative-opening', table: 'fundsmaster', section: '17.3', title: 'members with a negative opening balance (CDOPBAL)', expected: 6, from: 'fundsmaster', where: 'CDOPBAL < 0', sample: 'CONVERT(varchar(30),MBNO)' },
  { id: 'funds-suspense', table: 'fundsmaster', section: '17.3', title: 'members with a suspense balance', expected: 1, from: 'fundsmaster', where: 'ISNULL(SUSPBAL,0) <> 0', sample: 'CONVERT(varchar(30),MBNO)' },
  { id: 'funds-null-md1', table: 'fundsmaster', section: '17.3 (Q33)', title: 'MD1_AMOUNT is NULL (kept NULL)', expected: 517, from: 'fundsmaster', where: 'MD1_AMOUNT IS NULL', sample: 'CONVERT(varchar(30),MBNO)', severity: 'INFO' },
  // frs (18)
  { id: 'frs-repeated-members', table: 'frs', section: '18', title: 'member numbers repeated in the FRS list', expected: 3, from: '(SELECT MBNO FROM frs GROUP BY MBNO HAVING COUNT(*) > 1) q', where: '1=1', sample: 'CONVERT(varchar(30),MBNO)' },
  { id: 'frs-orphans', table: 'frs', section: '18', title: 'FRS rows with no member', expected: 33, from: 'frs t', where: NOT_MEMBER('MBNO'), sample: 'CONVERT(varchar(30),MBNO)' },
  // member_balances (19)
  { id: 'mb-orphans', table: 'member_balances', section: '19.1', title: 'legacy balance rows with no member (loaded and derived, no member record created)', expected: 107, from: 'member_balances t', where: NOT_MEMBER('MbNo'), sample: 'CONVERT(varchar(30),CONVERT(numeric(18,0),MbNo))' },
  { id: 'mb-junk-date', table: 'member_balances', section: '19.2', title: 'Dep_Date far in the future (junk value kept)', expected: 1, from: 'member_balances', where: 'Dep_Date > CONVERT(datetime,\'2100-01-01\',126)', sample: "CONVERT(varchar(30),CONVERT(numeric(18,0),MbNo))+' '+CONVERT(varchar(10),Dep_Date,126)" },
  { id: 'mb-acc-type-vs-head', table: 'member_balances', section: '19.8', title: 'members whose ledger rows have an ACC_TYPE that disagrees with the head code (CD/SHR vs L1004/L1001)', expected: 92,
    from: "(SELECT DISTINCT MBNO FROM ledger WHERE (ACC_TYPE='CD' AND CODE<>'L1004') OR (CODE='L1004' AND ISNULL(ACC_TYPE,'')<>'CD') OR (ACC_TYPE='SHR' AND CODE<>'L1001') OR (CODE='L1001' AND ISNULL(ACC_TYPE,'')<>'SHR')) q", where: '1=1', sample: 'CONVERT(varchar(30),MBNO)', severity: 'INFO' },
  // bank_cheq_master (20)
  { id: 'cheq-orphans', table: 'bank_cheq_master', section: '20', title: 'cheque rows with no member', expected: 379, from: 'bank_cheq_master t', where: "TRY_CAST(t.MBNO AS numeric(18,0)) IS NOT NULL AND TRY_CAST(t.MBNO AS numeric(18,0)) <> 0 AND " + NOT_MEMBER('MBNO'), sample: 'MBNO' },
  { id: 'cheq-no-voucher', table: 'bank_cheq_master', section: '20', title: 'cheque rows whose voucher number is not in the ledger', expected: 223, from: 'bank_cheq_master', where: 'RECEIPT_VCHR_NO NOT IN (SELECT RECEIPT_VCHR_NO FROM ledger WHERE RECEIPT_VCHR_NO IS NOT NULL)', sample: 'RECEIPT_VCHR_NO' },
  { id: 'cheq-incomplete', table: 'bank_cheq_master', section: '20', title: 'incomplete cheque rows (no cheque number, amount or date)', expected: 1068, from: 'bank_cheq_master', where: "(CHEQNO IS NULL OR LTRIM(RTRIM(CHEQNO))='' OR CHEQAMT IS NULL OR CHEQAMT=0 OR DATES IS NULL)", sample: 'RECEIPT_VCHR_NO' },
  // demand (21, 22)
  { id: 'demand-never-passed', table: 'demand_master', section: '21.3', title: 'demand rows never passed (posted Y / passed N, plus never posted)', expected: 629, from: 'demand_master', where: "(demand_posted='Y' AND PassFlag='N') OR ISNULL(demand_posted,'')<>'Y'", sample: "CONVERT(varchar(30),MBNO)+' '+CONVERT(varchar(4),demand_for_year)+'-'+CONVERT(varchar(2),demand_for_month)" },
  { id: 'demandmaster-delete-orphans', table: 'demand_masterdelete', section: '22', title: 'deleted-demand history rows with no member', expected: 8080, from: 'demand_masterdelete t', where: NOT_MEMBER('MBNO'), sample: 'CONVERT(varchar(30),MBNO)', severity: 'INFO' },
  // ledger (23)
  { id: 'ledger-orphan-members', table: 'ledger', section: '23.3, Q45', title: 'distinct member numbers in the ledger that are not in member_master (rows 4,382)', expected: 174, from: '(SELECT DISTINCT MBNO FROM ledger WHERE MBNO<>0 AND NOT EXISTS (SELECT 1 FROM member_master m WHERE m.MBNO=ledger.MBNO)) q', where: '1=1', sample: 'CONVERT(varchar(30),MBNO)' },
  { id: 'ledger-unbalanced-vouchers', table: 'ledger', section: '23.3', title: 'vouchers where debits differ from credits', expected: 20, from: "(SELECT RECEIPT_VCHR_NO FROM ledger GROUP BY RECEIPT_VCHR_NO HAVING SUM(CASE WHEN TRANS_TYPE='DR' THEN TRANS_AMT ELSE 0 END) <> SUM(CASE WHEN TRANS_TYPE='CR' THEN TRANS_AMT ELSE 0 END)) q", where: '1=1', sample: 'RECEIPT_VCHR_NO' },
  { id: 'ledger-before-start', table: 'ledger', section: '23.3', title: 'rows dated before 01-Nov-2019 (voucher J06039, 31-Mar-2019)', expected: 8, from: 'ledger', where: "TRANS_DATE < CONVERT(datetime,'2019-11-01',126)", sample: 'RECEIPT_VCHR_NO' , severity: 'INFO' },
  { id: 'ledger-zero-amount', table: 'ledger', section: '23.3', title: 'rows with amount 0', expected: 2940, from: 'ledger', where: 'TRANS_AMT = 0', sample: 'CONVERT(varchar(30),LedgerId)', severity: 'INFO' },
  // ledger_data / loan tables
  { id: 'ledgerdata-orphans', table: 'ledger_data', section: '24', title: 'rows with no member', expected: 35, from: 'ledger_data t', where: NOT_MEMBER('MBNO'), sample: 'CONVERT(varchar(30),MBNO)', severity: 'INFO' },
  { id: 'loanproduct-orphans', table: 'loan_product', section: '26', title: 'rows with no member', expected: 192, from: 'loan_product t', where: NOT_MEMBER('MBNo'), sample: 'CONVERT(varchar(30),MBNo)', severity: 'INFO' },
  { id: 'loanproduct-negative-interest', table: 'loan_product', section: '26', title: 'negative Interest values', expected: 562, from: 'loan_product', where: 'Interest < 0', sample: 'CONVERT(varchar(30),Id)', severity: 'INFO' },
  { id: 'loan-orphans', table: 'loan_master', section: '27.4', title: 'loan rows with no member', expected: 188, from: 'loan_master t', where: NOT_MEMBER('MBNO'), sample: "CONVERT(varchar(30),MBNO)+'/'+LOANTYPE+'/'+CONVERT(varchar(30),LOANCASENO)" },
  { id: 'loan-negative-balance', table: 'loan_master', section: '27.4', title: 'negative balances (LOAN_AMT and BALANCE)', expected: 136, from: 'loan_master', where: 'BALANCE < 0', sample: "CONVERT(varchar(30),MBNO)+'/'+LOANTYPE+'/'+CONVERT(varchar(30),LOANCASENO)" },
  { id: 'loan-zero-amount', table: 'loan_master', section: '27.4', title: 'rows with LOAN_AMT 0', expected: 7341, from: 'loan_master', where: 'LOAN_AMT = 0', sample: "CONVERT(varchar(30),MBNO)+'/'+LOANTYPE+'/'+CONVERT(varchar(30),LOANCASENO)", severity: 'INFO' },
  { id: 'loan-no-instalment', table: 'loan_master', section: '27.4', title: 'loans with a balance and no instalment amount', expected: 1142, from: 'loan_master', where: 'BALANCE > 0 AND ISNULL(INSTAL_AMT,0) = 0', sample: "CONVERT(varchar(30),MBNO)+'/'+LOANTYPE+'/'+CONVERT(varchar(30),LOANCASENO)" },
  { id: 'loan-balance-over-amount', table: 'loan_master', section: '27.4', title: 'loans whose balance exceeds the loan amount', expected: 1, from: 'loan_master', where: 'BALANCE > LOAN_AMT', sample: "CONVERT(varchar(30),MBNO)+'/'+LOANTYPE+'/'+CONVERT(varchar(30),LOANCASENO)" },
  { id: 'loan-penal-rate', table: 'loan_master', section: '27.4', title: 'rows carrying a penal rate', expected: 361, from: 'loan_master', where: 'ISNULL(PenalRate,0) <> 0', sample: "CONVERT(varchar(30),MBNO)+'/'+LOANTYPE+'/'+CONVERT(varchar(30),LOANCASENO)", severity: 'INFO' },
  { id: 'loanhistory-orphans', table: 'loan_masterhistory', section: '28', title: 'history rows with no member', expected: 113, from: 'loan_masterhistory t', where: NOT_MEMBER('MBNO'), sample: 'CONVERT(varchar(30),MBNO)', severity: 'INFO' },
  { id: 'loanhistory-only-here', table: 'loan_masterhistory', section: '28, 45.2', title: 'history rows of loans whose live row no longer exists (599 rows; fewer distinct loans)', expected: 599, from: 'loan_masterhistory h', where: 'NOT EXISTS (SELECT 1 FROM loan_master l WHERE l.MBNO=h.MBNO AND l.LOANTYPE=h.LOANTYPE AND l.LOANCASENO=h.LOANCASENO)', sample: "CONVERT(varchar(30),h.MBNO)+'/'+h.LOANTYPE+'/'+CONVERT(varchar(30),h.LOANCASENO)", severity: 'INFO' },
  { id: 'pending-orphans', table: 'loan_pending', section: '29.4', title: 'application rows with no member', expected: 191, from: 'loan_pending t', where: NOT_MEMBER('MBNO'), sample: 'CONVERT(varchar(30),LOANCASENO)' },
  { id: 'pending-junk-sanction', table: 'loan_pending', section: '29.2 (Q52)', title: 'sanctioned amount absurdly above the applied amount (kept as is)', expected: 1, from: 'loan_pending', where: 'SANCTIONED_AMT > 10000000 AND SANCTIONED_AMT > 100 * ISNULL(NULLIF(APPLIED_AMT,0),1)', sample: "CONVERT(varchar(30),LOANCASENO)+' member '+CONVERT(varchar(30),MBNO)" },
  { id: 'pending-sanctioned-not-paid', table: 'loan_pending', section: '29.2 (Q52)', title: 'sanctioned but not flagged paid', expected: 1, from: 'loan_pending', where: "FLG_SANCTIONED='Y' AND ISNULL(FLG_PAID,'N')<>'Y'", sample: "CONVERT(varchar(30),LOANCASENO)+' member '+CONVERT(varchar(30),MBNO)" },
  { id: 'lbh-orphans', table: 'loan_balance_history', section: '30', title: 'snapshot rows with no member', expected: 3100, from: 'loan_balance_history t', where: NOT_MEMBER('mbno'), sample: 'CONVERT(varchar(30),mbno)', severity: 'INFO' },
  { id: 'lbh-not-adding-up', table: 'loan_balance_history', section: '30', title: 'snapshot rows where opbal + debit - credit differs from balance', expected: 52133, from: 'loan_balance_history', where: 'ABS(ISNULL(opbal,0) + ISNULL(debit,0) - ISNULL(credit,0) - ISNULL(balance,0)) > 1', sample: "CONVERT(varchar(30),mbno)+' '+CONVERT(varchar(10),bal_date,126)", severity: 'INFO' },
  { id: 'lbh-nov-2026', table: 'loan_balance_history', section: '30', title: 'rows dated November 2026', expected: 4, from: 'loan_balance_history', where: "bal_date >= CONVERT(datetime,'2026-11-01',126)", sample: "CONVERT(varchar(30),mbno)+' '+CONVERT(varchar(10),bal_date,126)", severity: 'INFO' },
  // small tables
  { id: 'workingdate-duplicate-day', table: 'getworkingdate', section: '34.2', title: 'dates that appear twice (24-Sep-2021)', expected: 1, from: '(SELECT WORKING_DATE FROM getworkingdate GROUP BY WORKING_DATE HAVING COUNT(*) > 1) q', where: '1=1', sample: 'CONVERT(varchar(10),WORKING_DATE,126)' },
  { id: 'workingdate-ledger-day-without-row', table: 'getworkingdate', section: '34.2', title: 'ledger dates with no working-date row (31-Mar-2019)', expected: 1, from: '(SELECT DISTINCT CONVERT(date,TRANS_DATE) AS d FROM ledger l WHERE NOT EXISTS (SELECT 1 FROM getworkingdate g WHERE CONVERT(date,g.WORKING_DATE)=CONVERT(date,l.TRANS_DATE))) q', where: '1=1', sample: 'CONVERT(varchar(10),d,126)' },
  { id: 'surety-negative', table: 'suretymaster', section: '38', title: 'negative guarantor amounts', expected: 5, from: 'suretymaster', where: 'Amount < 0', sample: 'CONVERT(varchar(30),mbno)' },
  { id: 'surety-no-loan', table: 'suretymaster', section: '38', title: 'members with no loan', expected: 2, from: 'suretymaster', where: 'NOT EXISTS (SELECT 1 FROM loan_master l WHERE l.MBNO = suretymaster.mbno)', sample: 'CONVERT(varchar(30),mbno)' },
];

function countSql(q) { return `SELECT CONVERT(varchar(30),COUNT_BIG(*)) AS n FROM ${q.from} WHERE ${q.where}`; }
function sampleSql(q) { return `SELECT TOP 50 ${q.sample} AS s FROM ${q.from} WHERE ${q.where} ORDER BY 1`; }

/** Run one query; returns { count:Number, samples:[..] }. */
function runQuery(legacy, q) {
  const count = Number(legacy.scalar(countSql(q)));
  const samples = count > 0 ? legacy.rows(sampleSql(q)).map(r => r.s) : [];
  return { count, samples };
}

module.exports = { QUERIES, countSql, sampleSql, runQuery };
