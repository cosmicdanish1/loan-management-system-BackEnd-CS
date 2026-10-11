-- Support desk: what kind of query it is (BUG, QUESTION, DATA_CORRECTION, FEATURE_REQUEST, OTHER).
ALTER TABLE support_queries ADD COLUMN IF NOT EXISTS query_type varchar(20) NOT NULL DEFAULT 'OTHER';
