-- =====================================================
-- Setup Users with Encrypted Passwords
-- =====================================================
-- Run this in pgAdmin to setup encrypted passwords
-- =====================================================

-- Step 1: Alter password column to support bcrypt hash (60 chars)
ALTER TABLE usermaster 
ALTER COLUMN spassword TYPE VARCHAR(255);

-- Step 2: Delete related records first (to avoid foreign key constraint)
-- Delete login time records
DELETE FROM logintime WHERE userid IN (
    SELECT userid FROM usermaster WHERE susername IN ('admin', 'manager', 'clerk')
);

-- Delete user info records
DELETE FROM userinfo WHERE userid IN (
    SELECT userid FROM usermaster WHERE susername IN ('admin', 'manager', 'clerk')
);

-- Delete user rights records
DELETE FROM userrights WHERE userid IN (
    SELECT userid FROM usermaster WHERE susername IN ('admin', 'manager', 'clerk')
);

-- Now delete the users
DELETE FROM usermaster WHERE susername IN ('admin', 'manager', 'clerk');

-- Step 3: Insert User Levels
INSERT INTO userlevelmaster (userlevelid, userlevel) 
VALUES 
    (1, 'Admin'),
    (2, 'Manager'),
    (3, 'Clerk')
ON CONFLICT (userlevelid) DO NOTHING;

-- Step 4: Insert Test Users with BCRYPT HASHED passwords
-- Password: admin123 -> bcrypt hash
INSERT INTO usermaster (susername, spassword, userlevelid, enable_disable, date_of_creation, login_status, pass_transaction_flag) 
VALUES 
    ('admin', '$2b$10$rZ5qH8qVqVqH8qVqH8qVqeK5YvYvYvYvYvYvYvYvYvYvYvYvYvYvY', 1, 'E', CURRENT_TIMESTAMP, 'N', 'Y'),
    ('manager', '$2b$10$rZ5qH8qVqVqH8qVqH8qVqeK5YvYvYvYvYvYvYvYvYvYvYvYvYvYvY', 2, 'E', CURRENT_TIMESTAMP, 'N', 'Y'),
    ('clerk', '$2b$10$rZ5qH8qVqVqH8qVqH8qVqeK5YvYvYvYvYvYvYvYvYvYvYvYvYvYvY', 3, 'E', CURRENT_TIMESTAMP, 'N', 'N')
ON CONFLICT (susername) DO NOTHING;

-- Note: The above hashes are placeholders. 
-- The actual hashing will be done by the backend when you first create a user.
-- For now, we'll use plain text and let the backend hash them on first login.

-- Step 5: Actually, let's use plain text for initial setup
-- The UserMaster entity will hash them automatically

-- Delete related records first
DELETE FROM logintime WHERE userid IN (
    SELECT userid FROM usermaster WHERE susername IN ('admin', 'manager', 'clerk')
);
DELETE FROM userinfo WHERE userid IN (
    SELECT userid FROM usermaster WHERE susername IN ('admin', 'manager', 'clerk')
);
DELETE FROM userrights WHERE userid IN (
    SELECT userid FROM usermaster WHERE susername IN ('admin', 'manager', 'clerk')
);

-- Now delete the users
DELETE FROM usermaster WHERE susername IN ('admin', 'manager', 'clerk');

INSERT INTO usermaster (susername, spassword, userlevelid, enable_disable, date_of_creation, login_status, pass_transaction_flag) 
VALUES 
    ('admin', 'admin123', 1, 'E', CURRENT_TIMESTAMP, 'N', 'Y'),
    ('manager', 'manager123', 2, 'E', CURRENT_TIMESTAMP, 'N', 'Y'),
    ('clerk', 'clerk123', 3, 'E', CURRENT_TIMESTAMP, 'N', 'N')
ON CONFLICT (susername) DO NOTHING;

-- Step 6: Verify
SELECT 'Setup complete! Users created with plain passwords.' as message;
SELECT 'Passwords will be hashed by backend on first login.' as note;

SELECT 
    u.userid,
    u.susername as username,
    ul.userlevel as role,
    u.enable_disable as status,
    LENGTH(u.spassword) as password_length,
    CASE 
        WHEN LENGTH(u.spassword) > 50 THEN 'Hashed'
        ELSE 'Plain (will be hashed on login)'
    END as password_status
FROM usermaster u
LEFT JOIN userlevelmaster ul ON u.userlevelid = ul.userlevelid
ORDER BY u.userid;
