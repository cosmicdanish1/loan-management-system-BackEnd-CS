-- =====================================================
-- ANALYTICS DATABASE CREATION SCRIPT
-- Separate database for developer analytics and tracking
-- =====================================================

-- Create separate analytics database
CREATE DATABASE EMP_Analytics_DB
    WITH 
    OWNER = postgres
    ENCODING = 'UTF8'
    LC_COLLATE = 'English_United States.1252'
    LC_CTYPE = 'English_United States.1252'
    TABLESPACE = pg_default
    CONNECTION LIMIT = -1;

-- Connect to the analytics database
\c EMP_Analytics_DB;

-- Create extensions for analytics database
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- =====================================================
-- CORE ANALYTICS TABLES
-- =====================================================

-- 1. User Session Tracking
CREATE TABLE analytics_user_sessions (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(255) UNIQUE NOT NULL,
    user_id INTEGER,
    username VARCHAR(100),
    login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    logout_time TIMESTAMP,
    session_duration_minutes INTEGER,
    ip_address INET,
    user_agent TEXT,
    device_type VARCHAR(50), -- 'desktop', 'mobile', 'tablet'
    browser_name VARCHAR(100),
    browser_version VARCHAR(50),
    os_name VARCHAR(100),
    os_version VARCHAR(50),
    screen_resolution VARCHAR(20),
    timezone VARCHAR(50),
    app_version VARCHAR(20),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Page/Window Navigation Tracking
CREATE TABLE analytics_page_visits (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    page_name VARCHAR(200),
    window_title VARCHAR(300),
    route_path VARCHAR(500),
    component_name VARCHAR(200),
    visit_start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    visit_end_time TIMESTAMP,
    duration_seconds INTEGER,
    page_load_time_ms INTEGER,
    is_bounce BOOLEAN DEFAULT false,
    referrer_page VARCHAR(500),
    scroll_depth_percentage INTEGER,
    interactions_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Feature Usage Analytics
CREATE TABLE analytics_feature_usage (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    feature_category VARCHAR(100), -- 'Reports', 'Transaction', 'Masters', etc.
    feature_name VARCHAR(200),
    sub_feature VARCHAR(200),
    action_type VARCHAR(50), -- 'view', 'click', 'submit', 'download', 'print'
    action_details JSONB,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    execution_time_ms INTEGER,
    success_status BOOLEAN,
    error_message TEXT,
    user_input_data JSONB, -- Anonymized form data structure
    result_count INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Error Tracking & Logging
CREATE TABLE analytics_error_logs (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    error_id VARCHAR(255) UNIQUE,
    error_type VARCHAR(50), -- 'javascript', 'api', 'database', 'validation', 'network'
    severity_level VARCHAR(20), -- 'low', 'medium', 'high', 'critical'
    error_message TEXT NOT NULL,
    error_code VARCHAR(50),
    stack_trace TEXT,
    component_name VARCHAR(200),
    file_name VARCHAR(300),
    line_number INTEGER,
    column_number INTEGER,
    user_action_before_error TEXT,
    browser_console_logs TEXT,
    network_status VARCHAR(20),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_status BOOLEAN DEFAULT false,
    resolved_by VARCHAR(100),
    resolved_at TIMESTAMP,
    resolution_notes TEXT,
    occurrence_count INTEGER DEFAULT 1,
    first_occurrence TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_occurrence TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Database Operations Tracking
CREATE TABLE analytics_db_operations (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    operation_id VARCHAR(255),
    table_name VARCHAR(100),
    operation_type VARCHAR(20), -- 'SELECT', 'INSERT', 'UPDATE', 'DELETE'
    query_category VARCHAR(50), -- 'report', 'transaction', 'lookup', 'master_data'
    execution_time_ms INTEGER,
    record_count INTEGER,
    query_hash VARCHAR(64),
    query_complexity VARCHAR(20), -- 'simple', 'medium', 'complex'
    index_usage BOOLEAN,
    cache_hit BOOLEAN,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    success_status BOOLEAN,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. API Call Analytics
CREATE TABLE analytics_api_calls (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    request_id VARCHAR(255),
    endpoint VARCHAR(500),
    http_method VARCHAR(10),
    status_code INTEGER,
    response_time_ms INTEGER,
    request_size_bytes INTEGER,
    response_size_bytes INTEGER,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    success_status BOOLEAN,
    error_type VARCHAR(50),
    error_message TEXT,
    rate_limit_hit BOOLEAN DEFAULT false,
    cache_status VARCHAR(20), -- 'hit', 'miss', 'bypass'
    user_agent TEXT,
    ip_address INET,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Performance Metrics
CREATE TABLE analytics_performance_metrics (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    metric_type VARCHAR(50), -- 'page_load', 'api_response', 'database_query', 'memory_usage'
    metric_name VARCHAR(100),
    metric_value DECIMAL(10,3),
    metric_unit VARCHAR(20), -- 'ms', 'mb', 'percentage', 'count'
    component_name VARCHAR(200),
    threshold_value DECIMAL(10,3),
    is_threshold_exceeded BOOLEAN DEFAULT false,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    additional_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. Analytics Configuration
CREATE TABLE analytics_config (
    id SERIAL PRIMARY KEY,
    config_key VARCHAR(100) UNIQUE NOT NULL,
    config_value TEXT,
    config_type VARCHAR(20), -- 'boolean', 'integer', 'string', 'json'
    description TEXT,
    is_user_configurable BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by VARCHAR(100)
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

-- Session indexes
CREATE INDEX idx_analytics_sessions_user_id ON analytics_user_sessions(user_id);
CREATE INDEX idx_analytics_sessions_login_time ON analytics_user_sessions(login_time);
CREATE INDEX idx_analytics_sessions_active ON analytics_user_sessions(is_active);

-- Page visits indexes
CREATE INDEX idx_analytics_page_visits_session_id ON analytics_page_visits(session_id);
CREATE INDEX idx_analytics_page_visits_page_name ON analytics_page_visits(page_name);
CREATE INDEX idx_analytics_page_visits_timestamp ON analytics_page_visits(visit_start_time);

-- Feature usage indexes
CREATE INDEX idx_analytics_feature_usage_session_id ON analytics_feature_usage(session_id);
CREATE INDEX idx_analytics_feature_usage_category ON analytics_feature_usage(feature_category);
CREATE INDEX idx_analytics_feature_usage_timestamp ON analytics_feature_usage(timestamp);

-- Error logs indexes
CREATE INDEX idx_analytics_error_logs_session_id ON analytics_error_logs(session_id);
CREATE INDEX idx_analytics_error_logs_severity ON analytics_error_logs(severity_level);
CREATE INDEX idx_analytics_error_logs_timestamp ON analytics_error_logs(timestamp);
CREATE INDEX idx_analytics_error_logs_resolved ON analytics_error_logs(resolved_status);

-- DB operations indexes
CREATE INDEX idx_analytics_db_ops_session_id ON analytics_db_operations(session_id);
CREATE INDEX idx_analytics_db_ops_table_name ON analytics_db_operations(table_name);
CREATE INDEX idx_analytics_db_ops_timestamp ON analytics_db_operations(timestamp);

-- API calls indexes
CREATE INDEX idx_analytics_api_calls_session_id ON analytics_api_calls(session_id);
CREATE INDEX idx_analytics_api_calls_endpoint ON analytics_api_calls(endpoint);
CREATE INDEX idx_analytics_api_calls_timestamp ON analytics_api_calls(timestamp);
CREATE INDEX idx_analytics_api_calls_status ON analytics_api_calls(status_code);

-- Performance metrics indexes
CREATE INDEX idx_analytics_perf_session_id ON analytics_performance_metrics(session_id);
CREATE INDEX idx_analytics_perf_type ON analytics_performance_metrics(metric_type);
CREATE INDEX idx_analytics_perf_timestamp ON analytics_performance_metrics(timestamp);

-- =====================================================
-- DEFAULT CONFIGURATION VALUES
-- =====================================================

INSERT INTO analytics_config (config_key, config_value, config_type, description, is_user_configurable) VALUES
('analytics_enabled', 'false', 'boolean', 'Enable/disable analytics tracking', true),
('tracking_level', 'standard', 'string', 'Tracking level: minimal, standard, detailed, debug', true),
('data_retention_days', '90', 'integer', 'Number of days to retain analytics data', true),
('auto_cleanup_enabled', 'true', 'boolean', 'Enable automatic data cleanup', true),
('compression_enabled', 'true', 'boolean', 'Enable data compression for old records', true),
('batch_size', '100', 'integer', 'Batch size for data processing', true),
('flush_interval_seconds', '30', 'integer', 'Interval to flush queued data', true),
('max_queue_size', '1000', 'integer', 'Maximum queue size before forced flush', true),
('error_threshold', '10', 'integer', 'Error count threshold for alerts', true),
('performance_threshold_ms', '5000', 'integer', 'Performance threshold in milliseconds', true),
('real_time_alerts_enabled', 'false', 'boolean', 'Enable real-time alerts', true),
('anonymize_user_data', 'true', 'boolean', 'Anonymize sensitive user data', false),
('exclude_sensitive_data', 'true', 'boolean', 'Exclude sensitive data from tracking', false);

-- =====================================================
-- FUNCTIONS AND TRIGGERS
-- =====================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for analytics_user_sessions
CREATE TRIGGER update_analytics_sessions_updated_at 
    BEFORE UPDATE ON analytics_user_sessions 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Trigger for analytics_config
CREATE TRIGGER update_analytics_config_updated_at 
    BEFORE UPDATE ON analytics_config 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to calculate session duration
CREATE OR REPLACE FUNCTION calculate_session_duration()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.logout_time IS NOT NULL AND NEW.login_time IS NOT NULL THEN
        NEW.session_duration_minutes = EXTRACT(EPOCH FROM (NEW.logout_time - NEW.login_time)) / 60;
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for session duration calculation
CREATE TRIGGER calculate_session_duration_trigger
    BEFORE INSERT OR UPDATE ON analytics_user_sessions
    FOR EACH ROW EXECUTE FUNCTION calculate_session_duration();

-- =====================================================
-- VIEWS FOR COMMON QUERIES
-- =====================================================

-- Active sessions view
CREATE VIEW active_sessions AS
SELECT 
    session_id,
    username,
    login_time,
    device_type,
    browser_name,
    EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - login_time)) / 60 as current_duration_minutes
FROM analytics_user_sessions 
WHERE is_active = true;

-- Error summary view
CREATE VIEW error_summary AS
SELECT 
    error_type,
    severity_level,
    COUNT(*) as error_count,
    COUNT(CASE WHEN resolved_status = false THEN 1 END) as unresolved_count,
    MAX(timestamp) as last_occurrence
FROM analytics_error_logs 
GROUP BY error_type, severity_level;

-- Performance summary view
CREATE VIEW performance_summary AS
SELECT 
    metric_type,
    component_name,
    AVG(metric_value) as avg_value,
    MIN(metric_value) as min_value,
    MAX(metric_value) as max_value,
    COUNT(*) as measurement_count,
    COUNT(CASE WHEN is_threshold_exceeded = true THEN 1 END) as threshold_violations
FROM analytics_performance_metrics 
GROUP BY metric_type, component_name;

-- =====================================================
-- GRANT PERMISSIONS
-- =====================================================

-- Grant permissions to postgres user (adjust as needed)
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO postgres;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO postgres;

-- Create analytics user (optional)
-- CREATE USER analytics_user WITH PASSWORD 'analytics_password';
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO analytics_user;

COMMENT ON DATABASE EMP_Analytics_DB IS 'Separate database for developer analytics and user tracking';