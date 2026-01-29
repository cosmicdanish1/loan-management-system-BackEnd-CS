-- =====================================================
-- Check Users and Test Data
-- =====================================================
-- Run this in pgAdmin Query Tool to see all users
-- =====================================================

-- 1. Check if tables exist
SELECT 'Checking if tables exist...' as info;

SELECT 
    table_name,
    CASE 
        WHEN table_name IN ('usermaster', 'userlevelmaster', 'menumaster', 'userrights', 'userleveldefaultrights', 'userinfo', 'logintime')
        THEN '✓ EXISTS'
        ELSE '✗ MISSING'
    END as status
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('usermaster', 'userlevelmaster', 'menumaster', 'userrights', 'userleveldefaultrights', 'userinfo', 'logintime')
ORDER BY table_name;

-- 2. Check User Levels (Roles)
SELECT '========================================' as separator;
SELECT 'USER LEVELS (ROLES):' as info;
SELECT '========================================' as separator;

SELECT * FROM userlevelmaster ORDER BY userlevelid;

-- 3. Check All Users
SELECT '========================================' as separator;
SELECT 'ALL USERS IN DATABASE:' as info;
SELECT '========================================' as separator;

SELECT 
    userid,
    susername as username,
    userlevelid as role_id,
    enable_disable as status,
    login_status,
    date_of_creation as created_at
FROM usermaster
ORDER BY userid;

-- 4. Check Users with Role Names
SELECT '========================================' as separator;
SELECT 'USERS WITH ROLE NAMES:' as info;
SELECT '========================================' as separator;

SELECT 
    u.userid,
    u.susername as username,
    ul.userlevel as role,
    u.enable_disable as status,
    u.login_status,
    CASE 
        WHEN u.enable_disable = 'E' THEN '✓ Enabled'
        ELSE '✗ Disabled'
    END as account_status
FROM usermaster u
LEFT JOIN userlevelmaster ul ON u.userlevelid = ul.userlevelid
ORDER BY u.userid;

-- 5. Check Menu Items
SELECT '========================================' as separator;
SELECT 'AVAILABLE MENUS:' as info;
SELECT '========================================' as separator;

SELECT * FROM menumaster ORDER BY menuid;

-- 6. Check Default Permissions
SELECT '========================================' as separator;
SELECT 'DEFAULT PERMISSIONS PER ROLE:' as info;
SELECT '========================================' as separator;

SELECT 
    ul.userlevel as role,
    m.menuname as menu,
    m.menudesc as description
FROM userleveldefaultrights uld
JOIN userlevelmaster ul ON uld.userlevelid = ul.userlevelid
JOIN menumaster m ON uld.menuid = m.menuid
ORDER BY ul.userlevelid, m.menuid;

-- 7. Count records
SELECT '========================================' as separator;
SELECT 'RECORD COUNTS:' as info;
SELECT '========================================' as separator;

SELECT 
    'User Levels' as table_name,
    COUNT(*) as count
FROM userlevelmaster
UNION ALL
SELECT 
    'Users' as table_name,
    COUNT(*) as count
FROM usermaster
UNION ALL
SELECT 
    'Menus' as table_name,
    COUNT(*) as count
FROM menumaster
UNION ALL
SELECT 
    'Default Rights' as table_name,
    COUNT(*) as count
FROM userleveldefaultrights;

-- 8. Show test credentials
SELECT '========================================' as separator;
SELECT 'TEST CREDENTIALS:' as info;
SELECT '========================================' as separator;

SELECT 
    'Username: ' || susername || ' | Password: admin123 | Role: ' || ul.userlevel as credentials
FROM usermaster u
JOIN userlevelmaster ul ON u.userlevelid = ul.userlevelid
WHERE u.enable_disable = 'E'
ORDER BY u.userid;
