-- =====================================================
-- Clean and Setup Users with Encrypted Passwords
-- =====================================================
-- This script clears all auth data and creates fresh users
-- Run this in pgAdmin
-- =====================================================

-- Step 1: Clear all related data (in correct order to avoid FK constraints)
DELETE FROM logintime;
DELETE FROM userinfo;
DELETE FROM userrights;
DELETE FROM userleveldefaultrights;
DELETE FROM usermaster;
DELETE FROM userlevelmaster;
DELETE FROM menumaster;

-- Step 2: Alter password column to support bcrypt hash
ALTER TABLE usermaster 
ALTER COLUMN spassword TYPE VARCHAR(255);

-- Step 3: Insert User Levels
INSERT INTO userlevelmaster (userlevelid, userlevel) 
VALUES 
    (1, 'Admin'),
    (2, 'Manager'),
    (3, 'Clerk');

-- Step 4: Insert Menu Items
INSERT INTO menumaster (menuid, menuname, menudesc, visibleflag) 
VALUES 
    (1, 'Dashboard', 'Main dashboard', 'Y'),
    (2, 'Masters', 'Master data management', 'Y'),
    (3, 'Transactions', 'Transaction processing', 'Y'),
    (4, 'Reports', 'Reports and analytics', 'Y'),
    (5, 'Administration', 'System administration', 'Y');

-- Step 5: Insert Default Rights for User Levels
-- Admin gets all menus
INSERT INTO userleveldefaultrights (userlevelid, menuid) 
VALUES 
    (1, 1), (1, 2), (1, 3), (1, 4), (1, 5);

-- Manager gets most menus except Administration
INSERT INTO userleveldefaultrights (userlevelid, menuid) 
VALUES 
    (2, 1), (2, 2), (2, 3), (2, 4);

-- Clerk gets limited access
INSERT INTO userleveldefaultrights (userlevelid, menuid) 
VALUES 
    (3, 1), (3, 2), (3, 3);

-- Step 6: Insert Test Users with PLAIN TEXT passwords
-- The backend will hash them automatically on first login
INSERT INTO usermaster (susername, spassword, userlevelid, enable_disable, date_of_creation, login_status, pass_transaction_flag) 
VALUES 
    ('admin', 'admin123', 1, 'E', CURRENT_TIMESTAMP, 'N', 'Y'),
    ('manager', 'manager123', 2, 'E', CURRENT_TIMESTAMP, 'N', 'Y'),
    ('clerk', 'clerk123', 3, 'E', CURRENT_TIMESTAMP, 'N', 'N');

-- Step 7: Verify
SELECT '========================================' as separator;
SELECT 'SETUP COMPLETE!' as message;
SELECT '========================================' as separator;

SELECT 'User Levels:' as info;
SELECT * FROM userlevelmaster;

SELECT 'Test Users:' as info;
SELECT 
    u.userid,
    u.susername as username,
    ul.userlevel as role,
    u.enable_disable as status,
    LENGTH(u.spassword) as password_length,
    CASE 
        WHEN LENGTH(u.spassword) > 50 THEN '✓ Hashed'
        ELSE '○ Plain (will hash on login)'
    END as password_status
FROM usermaster u
LEFT JOIN userlevelmaster ul ON u.userlevelid = ul.userlevelid
ORDER BY u.userid;

SELECT 'Menu Items:' as info;
SELECT * FROM menumaster;

SELECT 'Default Rights:' as info;
SELECT 
    ul.userlevel as role,
    m.menuname as menu
FROM userleveldefaultrights uld
JOIN userlevelmaster ul ON uld.userlevelid = ul.userlevelid
JOIN menumaster m ON uld.menuid = m.menuid
ORDER BY ul.userlevelid, m.menuid;

SELECT '========================================' as separator;
SELECT 'You can now login with:' as info;
SELECT '  Username: admin     Password: admin123' as credentials;
SELECT '  Username: manager   Password: manager123' as credentials;
SELECT '  Username: clerk     Password: clerk123' as credentials;
SELECT '========================================' as separator;
