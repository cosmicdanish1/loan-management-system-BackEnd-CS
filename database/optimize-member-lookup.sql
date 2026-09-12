-- Optimization indexes for member_master table to speed up member lookup queries
-- Run this script to improve query performance

-- Index on isactive for filtering active members (most common filter)
CREATE INDEX IF NOT EXISTS idx_member_master_isactive 
ON member_master(isactive) 
WHERE isactive = 'Y';

-- Index on mbno for sorting and searching by member number
CREATE INDEX IF NOT EXISTS idx_member_master_mbno 
ON member_master(mbno);

-- Composite index for name searches (f_name, m_name, l_name)
CREATE INDEX IF NOT EXISTS idx_member_master_names 
ON member_master(f_name, m_name, l_name);

-- Index on officeno for filtering by office
CREATE INDEX IF NOT EXISTS idx_member_master_officeno 
ON member_master(officeno);

-- Analyze the table to update statistics for query planner
ANALYZE member_master;

-- Verify indexes were created
SELECT 
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'member_master'
ORDER BY indexname;
