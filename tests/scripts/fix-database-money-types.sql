-- Fix database money types for better financial data handling
-- This script converts numeric fields to proper money types where appropriate

-- 1. Fix ledger table - trans_amt should be money type (it already is)
-- Check current type
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'ledger' 
AND column_name IN ('trans_amt', 'pl_balance');

-- 2. Fix transactions table - trans_amt should be money type (it already is)
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'transactions' 
AND column_name IN ('trans_amt', 'cheq_amt');

-- 3. Fix member_master table - convert numeric salary fields to money
-- Note: Only run these if you want to change the data types
-- ALTER TABLE member_master ALTER COLUMN gross_salary TYPE money USING gross_salary::money;
-- ALTER TABLE member_master ALTER COLUMN basic_pay TYPE money USING basic_pay::money;
-- ALTER TABLE member_master ALTER COLUMN insureamt TYPE money USING insureamt::money;

-- 4. Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_ledger_mbno_date ON ledger(mbno, trans_date);
CREATE INDEX IF NOT EXISTS idx_ledger_code ON ledger(code);
CREATE INDEX IF NOT EXISTS idx_member_master_mbno ON member_master(mbno);
CREATE INDEX IF NOT EXISTS idx_head_master_code ON head_master(code);

-- 5. Update statistics
ANALYZE ledger;
ANALYZE member_master;
ANALYZE head_master;
ANALYZE transactions;

-- 6. Check data consistency
SELECT 'Ledger records with valid member' as check_type, COUNT(*) as count
FROM ledger l 
INNER JOIN member_master m ON l.mbno = m.mbno;

SELECT 'Ledger records with valid head' as check_type, COUNT(*) as count
FROM ledger l 
INNER JOIN head_master h ON l.code = h.code;

SELECT 'Members with transactions' as check_type, COUNT(DISTINCT l.mbno) as count
FROM ledger l;

-- 7. Sample data verification
SELECT 
  'Sample member with balances' as info,
  m.mbno,
  CONCAT(m.prefix, ' ', m.f_name, ' ', m.l_name) as name,
  COUNT(l.trans_no) as transaction_count,
  SUM(CASE WHEN l.trans_type = 'CR' THEN l.trans_amt::numeric ELSE -l.trans_amt::numeric END) as net_balance
FROM member_master m
INNER JOIN ledger l ON m.mbno = l.mbno
WHERE m.mbno IN (1001, 1002, 610023712)
GROUP BY m.mbno, m.prefix, m.f_name, m.l_name
ORDER BY m.mbno;