-- =====================================================
-- Reset Admin Password to Plain Text
-- =====================================================
-- This resets the admin password to 'admin123' in plain text
-- The backend will hash it on next login
-- =====================================================

-- Update admin password to plain text
UPDATE usermaster 
SET spassword = 'admin123'
WHERE susername = 'admin';

-- Verify
SELECT 
    userid,
    susername,
    LENGTH(spassword) as password_length,
    CASE 
        WHEN LENGTH(spassword) > 50 THEN 'Hashed'
        ELSE 'Plain text'
    END as password_type
FROM usermaster 
WHERE susername = 'admin';

SELECT 'Admin password reset to: admin123' as message;
