-- Fix day_end_processes table to have auto-increment ID
-- This script adds a sequence to the existing id column

-- Step 1: Create a sequence for the id column
CREATE SEQUENCE IF NOT EXISTS day_end_processes_id_seq;

-- Step 2: Set the sequence to start from the current max ID + 1
SELECT setval('day_end_processes_id_seq', COALESCE((SELECT MAX(id) FROM day_end_processes), 0) + 1, false);

-- Step 3: Alter the id column to use the sequence as default
ALTER TABLE day_end_processes 
ALTER COLUMN id SET DEFAULT nextval('day_end_processes_id_seq');

-- Step 4: Set the sequence owner to the id column (for proper cleanup)
ALTER SEQUENCE day_end_processes_id_seq OWNED BY day_end_processes.id;

-- Verify the change
SELECT column_name, column_default, is_nullable, data_type
FROM information_schema.columns
WHERE table_name = 'day_end_processes' AND column_name = 'id';
