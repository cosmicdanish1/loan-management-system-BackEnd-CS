-- =====================================================
-- USERRIGHTS Table
-- =====================================================
-- Description: Controls which menu/pages a user can access
-- From: EMP.sql
-- =====================================================

CREATE TABLE userrights (
    userid INTEGER NOT NULL,
    menuid INTEGER NOT NULL,
    PRIMARY KEY (userid, menuid),
    FOREIGN KEY (userid) REFERENCES usermaster(userid),
    FOREIGN KEY (menuid) REFERENCES menumaster(menuid)
);
