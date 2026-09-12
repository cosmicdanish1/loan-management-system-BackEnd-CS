-- =====================================================
-- LOGINTIME Table
-- =====================================================
-- Description: Stores session time, login/logout time, session duration
-- From: EMP.sql
-- =====================================================

CREATE TABLE logintime (
    login_date      timestamp NOT NULL,
    userid          smallint NOT NULL,
    login_time      varchar(12) NOT NULL DEFAULT '',
    logout_time     varchar(12) NOT NULL DEFAULT ''
);
