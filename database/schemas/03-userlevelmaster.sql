-- =====================================================
-- USERLEVELMASTER Table
-- =====================================================
-- Description: Defines user roles/levels (Admin, Clerk, etc.)
-- From: EMP.sql
-- =====================================================

CREATE TABLE userlevelmaster (
    userlevelid SMALLINT NOT NULL,
    userlevel VARCHAR(20) NOT NULL DEFAULT '',
    CONSTRAINT pk_userlevelmaster PRIMARY KEY (userlevelid)
);
