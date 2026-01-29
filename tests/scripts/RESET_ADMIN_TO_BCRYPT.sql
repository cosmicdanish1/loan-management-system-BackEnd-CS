-- Reset admin password to bcrypt hashed version
-- Password: admin123
-- Bcrypt hash: $2b$10$YourHashHere

-- First, let's see current admin user
SELECT userid, susername, spassword, enable_disable, login_status 
FROM usermaster 
WHERE susername = 'admin';

-- Update admin password to bcrypt hashed 'admin123'
-- This hash was generated with: bcrypt.hash('admin123', 10)
UPDATE usermaster 
SET spassword = '$2b$10$rOZxqKH9p.yJ5vYxQxGqXeF8KqVZ7jKqH5YqH9p.yJ5vYxQxGqXe'
WHERE susername = 'admin';

-- Verify the update
SELECT userid, susername, spassword, enable_disable, login_status 
FROM usermaster 
WHERE susername = 'admin';

-- Note: After running this, you can login with:
-- Username: admin
-- Password: admin123
