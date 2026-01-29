-- Create Sample Fixed Deposit Data for Testing
-- This script adds sample FD accounts for testing the FD Certificate and FD Statement features

-- First, let's check if we have any existing FD data
SELECT COUNT(*) as existing_fd_count FROM fdmaster;

-- Insert sample FD accounts for testing
-- Using member numbers that exist in the member_master table

-- Sample FD 1 - Active FD for member 1001
INSERT INTO fdmaster (
    mbno, prefix, f_name, m_name, l_name, certno, depunit, depperiod, rate, 
    depdate, matdate, fdamount, matamount, interestbalance, interestpayamentmode, 
    interestamount, lastintpaydate, intpaid, status, statusdate, nominee, 
    nage, naddr, nrelation, fdrdflag, remarks, openbal, rd_by_demand, 
    operationmode, intcalmethod, refmbno, minbal
) VALUES (
    1001, 'Mr', 'John', 'Kumar', 'Doe', 'FD001', 2, 12, 8.50,
    '2024-01-15', '2025-01-15', 100000, 108500, 0, 1,
    0, NULL, 0, '0', NULL, 'Jane Doe',
    '35', '123 Main Street, City', 'Spouse', 'F', 'Regular FD', 0, NULL,
    1, 1, NULL, 0
) ON CONFLICT (mbno, account_number) DO NOTHING;

-- Sample FD 2 - Active FD for member 1002  
INSERT INTO fdmaster (
    mbno, prefix, f_name, m_name, l_name, certno, depunit, depperiod, rate, 
    depdate, matdate, fdamount, matamount, interestbalance, interestpayamentmode, 
    interestamount, lastintpaydate, intpaid, status, statusdate, nominee, 
    nage, naddr, nrelation, fdrdflag, remarks, openbal, rd_by_demand, 
    operationmode, intcalmethod, refmbno, minbal
) VALUES (
    1002, 'Mrs', 'Jane', 'Kumari', 'Smith', 'FD002', 2, 24, 9.00,
    '2023-06-01', '2025-06-01', 250000, 295000, 0, 1,
    0, NULL, 0, '0', NULL, 'John Smith',
    '40', '456 Oak Avenue, Town', 'Husband', 'F', 'Long Term FD', 0, NULL,
    1, 1, NULL, 0
) ON CONFLICT (mbno, account_number) DO NOTHING;

-- Sample FD 3 - Active FD for member 1003
INSERT INTO fdmaster (
    mbno, prefix, f_name, m_name, l_name, certno, depunit, depperiod, rate, 
    depdate, matdate, fdamount, matamount, interestbalance, interestpayamentmode, 
    interestamount, lastintpaydate, intpaid, status, statusdate, nominee, 
    nage, naddr, nrelation, fdrdflag, remarks, openbal, rd_by_demand, 
    operationmode, intcalmethod, refmbno, minbal
) VALUES (
    1003, 'Mr', 'Robert', 'Kumar', 'Johnson', 'FD003', 2, 36, 9.25,
    '2023-03-10', '2026-03-10', 500000, 638750, 0, 1,
    0, NULL, 0, '0', NULL, 'Mary Johnson',
    '28', '789 Pine Road, Village', 'Wife', 'F', 'Premium FD', 0, NULL,
    1, 1, NULL, 0
) ON CONFLICT (mbno, account_number) DO NOTHING;

-- Sample FD 4 - Closed FD for testing account closing register
INSERT INTO fdmaster (
    mbno, prefix, f_name, m_name, l_name, certno, depunit, depperiod, rate, 
    depdate, matdate, fdamount, matamount, interestbalance, interestpayamentmode, 
    interestamount, lastintpaydate, intpaid, status, statusdate, nominee, 
    nage, naddr, nrelation, fdrdflag, remarks, openbal, rd_by_demand, 
    operationmode, intcalmethod, refmbno, minbal
) VALUES (
    1004, 'Ms', 'Sarah', '', 'Wilson', 'FD004', 2, 12, 8.00,
    '2023-12-01', '2024-12-01', 75000, 81000, 0, 1,
    0, NULL, 0, '1', '2024-12-01', 'David Wilson',
    '32', '321 Elm Street, City', 'Brother', 'F', 'Matured FD', 0, NULL,
    1, 1, NULL, 0
) ON CONFLICT (mbno, account_number) DO NOTHING;

-- Sample RD 1 - For testing RD functionality
INSERT INTO fdmaster (
    mbno, prefix, f_name, m_name, l_name, certno, depunit, depperiod, rate, 
    depdate, matdate, fdamount, matamount, interestbalance, interestpayamentmode, 
    interestamount, lastintpaydate, intpaid, status, statusdate, nominee, 
    nage, naddr, nrelation, fdrdflag, remarks, openbal, rd_by_demand, 
    operationmode, intcalmethod, refmbno, minbal
) VALUES (
    1005, 'Mr', 'Michael', 'Kumar', 'Brown', 'RD001', 2, 60, 7.50,
    '2023-01-01', '2028-01-01', 5000, 350000, 0, 1,
    0, NULL, 0, '0', NULL, 'Lisa Brown',
    '30', '654 Maple Drive, Town', 'Wife', 'R', 'Monthly RD', 0, 'Y',
    1, 1, NULL, 1000
) ON CONFLICT (mbno, account_number) DO NOTHING;

-- Check the inserted data
SELECT 
    mbno, 
    CONCAT(prefix, ' ', f_name, ' ', COALESCE(m_name, ''), ' ', l_name) as member_name,
    certno, 
    fdamount, 
    rate, 
    depdate, 
    matdate, 
    fdrdflag,
    status
FROM fdmaster 
ORDER BY mbno;

-- Show summary
SELECT 
    fdrdflag,
    status,
    COUNT(*) as count,
    SUM(fdamount) as total_amount
FROM fdmaster 
GROUP BY fdrdflag, status
ORDER BY fdrdflag, status;