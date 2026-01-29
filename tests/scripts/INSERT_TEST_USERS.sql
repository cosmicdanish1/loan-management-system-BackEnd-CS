-- =====================================================
-- Insert Test Users - Run this in pgAdmin
-- =====================================================

-- Step 1: Insert User Levels
INSERT INTO userlevelmaster (userlevelid, userlevel) 
VALUES 
    (1, 'Admin'),
    (2, 'Manager'),
    (3, 'Clerk')
ON CONFLICT (userlevelid) DO NOTHING;

-- Step 2: Insert Test Users
INSERT INTO usermaster (susername, spassword, userlevelid, enable_disable, date_of_creation, login_status, pass_transaction_flag) 
VALUES 
    ('admin', 'admin123', 1, 'E', CURRENT_TIMESTAMP, 'N', 'Y'),
    ('manager', 'manager123', 2, 'E', CURRENT_TIMESTAMP, 'N', 'Y'),
    ('clerk', 'clerk123', 3, 'E', CURRENT_TIMESTAMP, 'N', 'N')
ON CONFLICT (susername) DO NOTHING;

-- Step 3: Verify
SELECT 'Users created successfully!' as message;

SELECT 
    u.userid,
    u.susername as username,
    ul.userlevel as role,
    u.enable_disable as status
FROM usermaster u
LEFT JOIN userlevelmaster ul ON u.userlevelid = ul.userlevelid
ORDER BY u.userid;
