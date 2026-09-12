-- Test Data for Financial Summary Report
-- This script adds sample account heads and transactions for testing

-- First, let's add some test account heads if they don't exist
INSERT INTO headmaster (code, parent_code, hposition, head_name, interest, headtype, op_bal, pflag)
VALUES 
  ('CASH', '', '001', 'Cash in Hand', 'N', 'AST', 50000, ''),
  ('BANK', '', '002', 'Bank Account', 'N', 'AST', 100000, ''),
  ('LOAN', '', '003', 'Loans Payable', 'Y', 'LIA', 200000, ''),
  ('SAL', '', '004', 'Salary Expense', 'N', 'EXP', 0, ''),
  ('INT', '', '005', 'Interest Income', 'Y', 'INC', 0, '')
ON CONFLICT (code) DO NOTHING;

-- Now add some test transactions in the ledger
-- Using recent dates so they show up in reports

-- Transaction 1: Cash received (Credit to Cash)
INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username)
VALUES 
  (1001, '2024-04-15', 'CR', 'CASH', 0, 0, '', 25000, 'RV001', 'RV', 'C', 0, 'Cash Received - Test', 'admin'),
  (1002, '2024-04-15', 'DR', 'LOAN', 0, 0, '', 25000, 'RV001', 'RV', 'C', 0, 'Loan Disbursed - Test', 'admin');

-- Transaction 2: Bank deposit (Debit to Bank, Credit to Cash)
INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username)
VALUES 
  (1003, '2024-05-10', 'DR', 'BANK', 0, 0, '', 15000, 'JV001', 'JV', 'T', 0, 'Bank Deposit - Test', 'admin'),
  (1004, '2024-05-10', 'CR', 'CASH', 0, 0, '', 15000, 'JV001', 'JV', 'T', 0, 'Bank Deposit - Test', 'admin');

-- Transaction 3: Salary Payment (Debit to Salary, Credit to Bank)
INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username)
VALUES 
  (1005, '2024-06-01', 'DR', 'SAL', 0, 0, '', 35000, 'PV001', 'PV', 'C', 0, 'Salary Payment - Test', 'admin'),
  (1006, '2024-06-01', 'CR', 'BANK', 0, 0, '', 35000, 'PV001', 'PV', 'C', 0, 'Salary Payment - Test', 'admin');

-- Transaction 4: Interest Income (Credit to Interest Income)
INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username)
VALUES 
  (1007, '2024-07-15', 'CR', 'INT', 0, 0, '', 8500, 'RV002', 'RV', 'T', 0, 'Interest Income - Test', 'admin'),
  (1008, '2024-07-15', 'DR', 'BANK', 0, 0, '', 8500, 'RV002', 'RV', 'T', 0, 'Interest Received - Test', 'admin');

-- Transaction 5: Loan Repayment
INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username)
VALUES 
  (1009, '2024-08-20', 'DR', 'CASH', 0, 0, '', 12000, 'RV003', 'RV', 'C', 0, 'Loan Repayment - Test', 'admin'),
  (1010, '2024-08-20', 'CR', 'LOAN', 0, 0, '', 12000, 'RV003', 'RV', 'C', 0, 'Loan Repayment - Test', 'admin');

-- Verify the data
SELECT 'Account Heads:' as info;
SELECT * FROM headmaster WHERE code IN ('CASH', 'BANK', 'LOAN', 'SAL', 'INT');

SELECT 'Transactions:' as info;
SELECT trans_no, trans_date, trans_type, code, trans_amt, narration 
FROM ledger 
WHERE trans_no >= 1001 AND trans_no <= 1010
ORDER BY trans_date, trans_no;

-- Summary by account
SELECT 'Summary by Account:' as info;
SELECT 
  l.code,
  h.head_name,
  COUNT(*) as transaction_count,
  SUM(CASE WHEN l.trans_type = 'DR' THEN l.trans_amt ELSE 0 END) as total_debit,
  SUM(CASE WHEN l.trans_type = 'CR' THEN l.trans_amt ELSE 0 END) as total_credit
FROM ledger l
LEFT JOIN headmaster h ON l.code = h.code
WHERE l.trans_no >= 1001 AND l.trans_no <= 1010
GROUP BY l.code, h.head_name
ORDER BY l.code;
