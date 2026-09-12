-- =====================================================
-- Test User Data for Login Testing
-- =====================================================
-- Description: Creates test users, roles, and permissions
-- Usage: Run this in pgAdmin or psql to create test data
-- =====================================================

-- Step 1: Insert User Levels (Roles)
INSERT INTO userlevelmaster (userlevelid, userlevel) 
VALUES 
    (1, 'Admin'),
    (2, 'Manager'),
    (3, 'Clerk')
ON CONFLICT (userlevelid) DO NOTHING;

-- Step 2: Insert Menu Items
INSERT INTO menumaster (menuid, menuname, menudesc, visibleflag) 
VALUES 
    (1, 'Dashboard', 'Main dashboard', 'Y'),
    (2, 'Masters', 'Master data management', 'Y'),
    (3, 'Transactions', 'Transaction processing', 'Y'),
    (4, 'Reports', 'Reports and analytics', 'Y'),
    (5, 'Administration', 'System administration', 'Y')
ON CONFLICT (menuid) DO NOTHING;

-- Step 3: Insert Test Users
-- Password: admin123 (will be hashed by backend)
INSERT INTO usermaster (susername, spassword, userlevelid, enable_disable, date_of_creation, login_status, pass_transaction_flag) 
VALUES 
    ('admin', 'admin123', 1, 'E', CURRENT_TIMESTAMP, 'N', 'Y'),
    ('manager', 'manager123', 2, 'E', CURRENT_TIMESTAMP, 'N', 'Y'),
    ('clerk', 'clerk123', 3, 'E', CURRENT_TIMESTAMP, 'N', 'N')
ON CONFLICT (susername) DO NOTHING;

-- Step 4: Insert Default Rights for User Levels
-- Admin gets all menus
INSERT INTO userleveldefaultrights (userlevelid, menuid) 
VALUES 
    (1, 1), (1, 2), (1, 3), (1, 4), (1, 5)
ON CONFLICT (userlevelid, menuid) DO NOTHING;

-- Manager gets most menus except Administration
INSERT INTO userleveldefaultrights (userlevelid, menuid) 
VALUES 
    (2, 1), (2, 2), (2, 3), (2, 4)
ON CONFLICT (userlevelid, menuid) DO NOTHING;

-- Clerk gets limited access
INSERT INTO userleveldefaultrights (userlevelid, menuid) 
VALUES 
    (3, 1), (3, 2), (3, 3)
ON CONFLICT (userlevelid, menuid) DO NOTHING;

-- Step 5: Verify data
SELECT 'User Levels:' as info;
SELECT * FROM userlevelmaster;

SELECT 'Test Users:' as info;
SELECT userid, susername, userlevelid, enable_disable, login_status FROM usermaster;

SELECT 'Menu Items:' as info;
SELECT * FROM menumaster;

SELECT 'Default Rights:' as info;
SELECT uld.*, ul.userlevel, m.menuname 
FROM userleveldefaultrights uld
JOIN userlevelmaster ul ON uld.userlevelid = ul.userlevelid
JOIN menumaster m ON uld.menuid = m.menuid
ORDER BY uld.userlevelid, uld.menuid;
