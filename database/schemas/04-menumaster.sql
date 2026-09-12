-- =====================================================
-- MENUMASTER Table
-- =====================================================
-- Description: Controls which menu/pages are available in system
-- From: EMP.sql
-- =====================================================

CREATE TABLE menumaster (
    menuid INTEGER NOT NULL,
    menuname VARCHAR(50) NOT NULL DEFAULT '',
    menudesc VARCHAR(50) NOT NULL DEFAULT '',
    visibleflag CHAR(1),

    CONSTRAINT pk_menumaster PRIMARY KEY (menuid)
);
