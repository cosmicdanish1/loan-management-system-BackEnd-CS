-- AI assistant conversation log (ES-439). Same DDL as src/migrations/1791417600000-CreateAiChatLogs.ts.
CREATE TABLE IF NOT EXISTS ai_chat_logs (
    id SERIAL PRIMARY KEY,
    user_id varchar(50),
    username varchar(100),
    role varchar(50),
    route varchar(300),
    question text NOT NULL,
    answer text,
    provider varchar(20) NOT NULL DEFAULT 'none',
    status varchar(20) NOT NULL DEFAULT 'OK',
    failure_reason varchar(20),
    latency_ms integer NOT NULL DEFAULT 0,
    feedback smallint,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_logs_user ON ai_chat_logs (username, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_chat_logs_status ON ai_chat_logs (status, created_at DESC);
