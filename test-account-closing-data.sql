-- Test data for Account Closing Register
-- Insert some sample closed FD accounts

-- First, let's check existing data
SELECT COUNT(*) as total_fd_accounts FROM fdmaster;
SELECT COUNT(*) as closed_fd_accounts FROM fdmaster WHERE status = '1';

-- Insert sample closed FD accounts if none exist
INSERT INTO fdmaster (
  mbno, account_number, prefix, f_name, m_name, l_name, 
  certno, depunit, depperiod, rate, depdate, matdate, 
  fdamount, matamount, interestbalance, interestpayamentmode, 
  interestamount, status, statusdate, fdrdflag
) VALUES 
(1001, 1001, 'Mr', 'John', 'A', 'Doe', 'FD001', 2, 12, 8.5, '2023-01-15', '2024-01-15', 100000, 108500, 0, 1, 8500, '1', '2024-12-15', 'F'),
(1002, 1002, 'Mrs', 'Jane', 'B', 'Smith', 'FD002', 2, 24, 9.0, '2022-06-01', '2024-06-01', 200000, 236000, 0, 1, 36000, '1', '2024-12-10', 'F'),
(1003, 1003, 'Mr', 'Robert', 'C', 'Johnson', 'RD001', 2, 36, 7.5, '2021-12-01', '2024-12-01', 180000, 220500, 0, 1, 40500, '1', '2024-12-05', 'R')
ON CONFLICT (mbno, account_number) DO NOTHING;

-- Insert corresponding member data if not exists
INSERT INTO member_master (
  mbno, prefix, f_name, m_name, l_name, sex, desig, 
  present_address, permanent_address, wingno, officeno, 
  age, gross_salary, basic_pay, nominee_name, 
  nominee_address, nominee_relation, flg_retire, 
  pfno, lfno, flg_incometax, flg_insured, insureamt, 
  remarks, isactive
) VALUES 
(1001, 'Mr', 'John', 'A', 'Doe', 'M', 'Manager', '123 Main St', '123 Main St', '001', 1, '35', 50000, 30000, 'Jane Doe', '123 Main St', 'Wife', 'N', 'PF001', 'LF001', 'N', 'Y', 100000, 'Test Member', 'Y'),
(1002, 'Mrs', 'Jane', 'B', 'Smith', 'F', 'Assistant', '456 Oak Ave', '456 Oak Ave', '002', 2, '32', 45000, 28000, 'John Smith', '456 Oak Ave', 'Husband', 'N', 'PF002', 'LF002', 'N', 'Y', 90000, 'Test Member', 'Y'),
(1003, 'Mr', 'Robert', 'C', 'Johnson', 'M', 'Clerk', '789 Pine Rd', '789 Pine Rd', '003', 3, '28', 40000, 25000, 'Mary Johnson', '789 Pine Rd', 'Wife', 'N', 'PF003', 'LF003', 'N', 'Y', 80000, 'Test Member', 'Y')
ON CONFLICT (mbno) DO NOTHING;

-- Verify the test data
SELECT 
  f.mbno,
  CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as member_name,
  f.account_number,
  CASE WHEN f.fdrdflag = 'F' THEN 'FD' ELSE 'RD' END as account_type,
  f.statusdate as closing_date,
  f.matamount as final_amount
FROM fdmaster f
INNER JOIN member_master m ON f.mbno = m.mbno
WHERE f.status = '1'
  AND EXTRACT(MONTH FROM f.statusdate) = 12
  AND EXTRACT(YEAR FROM f.statusdate) = 2024;