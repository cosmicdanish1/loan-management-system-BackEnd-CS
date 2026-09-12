-- =====================================================
-- USERLEVELDEFAULTRIGHTS Table
-- =====================================================
-- Description: Controls what rights each user level gets by default
-- From: EMP.sql
-- =====================================================

CREATE TABLE userleveldefaultrights (
    userlevelid SMALLINT NOT NULL,
    menuid INTEGER NOT NULL,

    CONSTRAINT pk_userleveldefaultrights PRIMARY KEY (userlevelid, menuid),

    CONSTRAINT fk_userleveldefaultrights_menu
        FOREIGN KEY (menuid) REFERENCES menumaster(menuid),

    CONSTRAINT fk_userleveldefaultrights_userlevel
        FOREIGN KEY (userlevelid) REFERENCES userlevelmaster(userlevelid)
);
