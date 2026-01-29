-- Create sample members
INSERT INTO member_master (
  mbno, prefix, f_name, m_name, l_name, sex, desig, 
  present_address, permanent_address, wingno, officeno, 
  age, gross_salary, basic_pay, flg_retire, isactive
) VALUES 
  ('100001', 'Mr', 'John', 'A', 'Doe', 'M', 'Manager', '123 Main Street', '123 Main Street', '001', 1, '35', 50000, 30000, 'N', 'Y'),
  ('100002', 'Ms', 'Jane', 'B', 'Smith', 'F', 'Assistant', '456 Oak Avenue', '456 Oak Avenue', '001', 1, '28', 40000, 25000, 'N', 'Y'),
  ('100003', 'Mr', 'Robert', 'C', 'Johnson', 'M', 'Clerk', '789 Pine Road', '789 Pine Road', '002', 2, '42', 35000, 20000, 'N', 'Y')
ON CONFLICT (mbno) DO NOTHING;

-- Create sample head masters
INSERT INTO headmaster (code, head_name, headtype, parent_code, hposition, interest, op_bal, pflag)
VALUES 
  ('A1001', 'CASH IN HAND', 'CASH', '', '', 'N', 0, ''),
  ('A1002', 'SAVINGS BANK ACCOUNT', 'BANK', '', '', 'Y', 0, ''),
  ('L1001', 'REGULAR LOAN ACCOUNT', 'LOAN', '', '', 'Y', 0, ''),
  ('L1002', 'EMERGENCY LOAN ACCOUNT', 'LOAN', '', '', 'Y', 0, ''),
  ('I1001', 'INTEREST INCOME', 'INCO', '', '', 'N', 0, ''),
  ('E1001', 'OFFICE EXPENSES', 'EXPE', '', '', 'N', 0, '')
ON CONFLICT (code) DO NOTHING;

-- Create sample ledger entries for member 100001
INSERT INTO ledger (
  trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
  trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
  narration, username
) VALUES 
  (1001, '2024-11-01', 'CR', 'A1002', 100001, 0, 'SB', 5000.00, 'V1001', 'R', 'C', 5000.00, 'Opening deposit', 'admin'),
  (1002, '2024-11-05', 'CR', 'A1002', 100001, 0, 'SB', 2000.00, 'V1002', 'R', 'C', 7000.00, 'Monthly deposit', 'admin'),
  (1003, '2024-11-10', 'DR', 'A1002', 100001, 0, 'SB', 500.00, 'V1003', 'P', 'C', 6500.00, 'Withdrawal', 'admin'),
  (1004, '2024-11-15', 'CR', 'I1001', 100001, 0, 'SB', 150.00, 'V1004', 'J', 'C', 150.00, 'Interest credit', 'admin'),
  (1005, '2024-12-01', 'CR', 'A1002', 100001, 0, 'SB', 3000.00, 'V1005', 'R', 'C', 9500.00, 'December deposit', 'admin'),
  (1006, '2024-12-10', 'DR', 'A1002', 100001, 0, 'SB', 1000.00, 'V1006', 'P', 'C', 8500.00, 'ATM withdrawal', 'admin')
ON CONFLICT (trans_no) DO NOTHING;

-- Create sample ledger entries for member 100002
INSERT INTO ledger (
  trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
  trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
  narration, username
) VALUES 
  (2001, '2024-11-01', 'CR', 'L1001', 100002, 0, 'LN', 25000.00, 'V2001', 'R', 'C', 25000.00, 'Loan disbursement', 'admin'),
  (2002, '2024-11-07', 'DR', 'L1001', 100002, 0, 'LN', 1200.00, 'V2002', 'P', 'C', 23800.00, 'EMI payment', 'admin'),
  (2003, '2024-12-07', 'DR', 'L1001', 100002, 0, 'LN', 1200.00, 'V2003', 'P', 'C', 22600.00, 'EMI payment', 'admin')
ON CONFLICT (trans_no) DO NOTHING;

-- Create sample ledger entries for member 100003
INSERT INTO ledger (
  trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
  trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance,
  narration, username
) VALUES 
  (3001, '2024-11-01', 'CR', 'A1002', 100003, 0, 'SB', 3000.00, 'V3001', 'R', 'C', 3000.00, 'Initial deposit', 'admin'),
  (3002, '2024-11-03', 'CR', 'L1002', 100003, 0, 'LN', 5000.00, 'V3002', 'R', 'C', 5000.00, 'Emergency loan', 'admin'),
  (3003, '2024-11-12', 'DR', 'L1002', 100003, 0, 'LN', 500.00, 'V3003', 'P', 'C', 4500.00, 'Loan repayment', 'admin'),
  (3004, '2024-12-05', 'CR', 'A1002', 100003, 0, 'SB', 1500.00, 'V3004', 'R', 'C', 4500.00, 'Monthly deposit', 'admin')
ON CONFLICT (trans_no) DO NOTHING;