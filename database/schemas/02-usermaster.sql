-- =====================================================
-- USERMASTER Table
-- =====================================================
-- Description: Stores username, password, enable/disable flag, login status
-- From: EMP.sql
-- =====================================================

CREATE TABLE usermaster (
    userid INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    susername VARCHAR(20) NOT NULL,
    spassword VARCHAR(255) NOT NULL, -- Increased to 255 for bcrypt hash
    userlevelid SMALLINT NOT NULL,
    enable_disable VARCHAR(1) NOT NULL DEFAULT 'E',
    date_of_creation TIMESTAMP NULL,
    date_of_disable_enable TIMESTAMP NULL,
    login_status VARCHAR(1) NOT NULL DEFAULT 'N',
    pass_transaction_flag CHAR(1) NULL DEFAULT 'N',

    CONSTRAINT fk_usermaster_userlevelmaster
        FOREIGN KEY (userlevelid) REFERENCES userlevelmaster(userlevelid),

    CONSTRAINT ck_usermaster_enable_disable
        CHECK (enable_disable IN ('D','E')),

    CONSTRAINT ck_usermaster_login_status
        CHECK (login_status IN ('N','Y'))
);
