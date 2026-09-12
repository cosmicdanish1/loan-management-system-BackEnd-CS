-- =====================================================
-- USERINFO Table
-- =====================================================
-- Description: Tracks abnormal login status, hostname, etc.
-- From: EMP.sql
-- =====================================================

CREATE TABLE userinfo (
    userid INTEGER NOT NULL,
    hostname VARCHAR(20) NOT NULL DEFAULT '',
    abnormal_status VARCHAR(1) NOT NULL DEFAULT 'N',

    CONSTRAINT fk_userinfo_usermaster
        FOREIGN KEY (userid)
        REFERENCES usermaster(userid)
);
