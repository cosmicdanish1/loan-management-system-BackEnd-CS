-- Fix password column length to support bcrypt hashes
-- Bcrypt hashes are 60 characters long, but column is only 20

-- Check current column definition
SELECT column_name, data_type, character_maximum_length 
FROM information_schema.columns 
WHERE table_name = 'usermaster' AND column_name = 'spassword';

-- Alter column to support bcrypt hashes (60 characters)
ALTER TABLE usermaster 
ALTER COLUMN spassword TYPE VARCHAR(255);

-- Verify the change
SELECT column_name, data_type, character_maximum_length 
FROM information_schema.columns 
WHERE table_name = 'usermaster' AND column_name = 'spassword';

-- Now you can run: node backend/reset-admin-password.js
