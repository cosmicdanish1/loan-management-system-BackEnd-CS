-- First, find the next available ledgerid
SELECT COALESCE(MAX(ledgerid), 0) + 1 as next_id FROM ledger;

-- Use that number and replace 5100, 5101, etc. below with your actual next IDs
-- Also use high trans_no like 95001, 95002, etc.

-- Add dividend payment test data
INSERT INTO ledger (
    ledgerid, trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, 
    trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username
)
VALUES 
    (5100, 95001, '2024-05-15', 'DR', 'CASH', 1001, 0, '', 1500, 'DIV001', 'PV', 'C', 0, 'Dividend Payment 2024', 'admin'),
    (5101, 95002, '2024-05-15', 'DR', 'CASH', 1002, 0, '', 2000, 'DIV001', 'PV', 'C', 0, 'Dividend Payment 2024', 'admin'),
    (5102, 95003, '2024-06-01', 'DR', 'CASH', 1003, 0, '', 1800, 'DIV002', 'PV', 'C', 0, 'Dividend Payment 2024', 'admin'),
    (5103, 95004, '2024-07-10', 'DR', 'CASH', 1004, 0, '', 2500, 'DIV003', 'PV', 'C', 0, 'Dividend Payment 2024', 'admin'),
    (5104, 95005, '2024-08-20', 'DR', 'CASH', 1005, 0, '', 1200, 'DIV004', 'PV', 'C', 0, 'Dividend Payment 2024', 'admin');

-- Verify the data
SELECT 
    trans_no, trans_date, trans_type, mbno, trans_amt, narration
FROM ledger 
WHERE trans_no >= 95001 AND trans_no <= 95005
ORDER BY trans_date;
