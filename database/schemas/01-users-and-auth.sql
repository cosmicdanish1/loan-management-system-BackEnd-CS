-- =====================================================
-- USER AUTHENTICATION AND AUTHORIZATION TABLES
-- =====================================================
-- Description: Tables for user management, authentication, and access control
-- Last Updated: November 2024
-- =====================================================

-- User Master Table
CREATE TABLE usermaster (
    userid INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    susername VARCHAR(20) NOT NULL,
    spassword VARCHAR(20) NOT NULL,
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

COMMENT ON TABLE usermaster IS 'Stores user account information and authentication details';
COMMENT ON COLUMN usermaster.userid IS 'Unique user identifier (auto-generated)';
COMMENT ON COLUMN usermaster.susername IS 'Username for login';
COMMENT ON COLUMN usermaster.spassword IS 'User password (should be hashed in production)';
COMMENT ON COLUMN usermaster.enable_disable IS 'E=Enabled, D=Disabled';
COMMENT ON COLUMN usermaster.login_status IS 'Y=Logged in, N=Logged out';

-- User Level Master Table
CREATE TABLE userlevelmaster (
    userlevelid SMALLINT NOT NULL,
    userlevel VARCHAR(20) NOT NULL DEFAULT '',
    CONSTRAINT pk_userlevelmaster PRIMARY KEY (userlevelid)
);

COMMENT ON TABLE userlevelmaster IS 'Defines user roles/levels (Admin, Manager, Cashier, etc.)';

-- Menu Master Table
CREATE TABLE menumaster (
    menuid INTEGER NOT NULL,
    menuname VARCHAR(50) NOT NULL DEFAULT '',
    menudesc VARCHAR(50) NOT NULL DEFAULT '',
    visibleflag CHAR(1),

    CONSTRAINT pk_menumaster PRIMARY KEY (menuid)
);

COMMENT ON TABLE menumaster IS 'Stores all menu items and features in the system';

-- User Rights Table
CREATE TABLE userrights (
    userid INTEGER NOT NULL,
    menuid INTEGER NOT NULL,
    PRIMARY KEY (userid, menuid),
    FOREIGN KEY (userid) REFERENCES usermaster(userid),
    FOREIGN KEY (menuid) REFERENCES menumaster(menuid)
);

COMMENT ON TABLE userrights IS 'Maps which menus/features each user can access';

-- User Level Default Rights Table
CREATE TABLE userleveldefaultrights (
    userlevelid SMALLINT NOT NULL,
    menuid INTEGER NOT NULL,

    CONSTRAINT pk_userleveldefaultrights PRIMARY KEY (userlevelid, menuid),

    CONSTRAINT fk_userleveldefaultrights_menu
        FOREIGN KEY (menuid) REFERENCES menumaster(menuid),

    CONSTRAINT fk_userleveldefaultrights_userlevel
        FOREIGN KEY (userlevelid) REFERENCES userlevelmaster(userlevelid)
);

COMMENT ON TABLE userleveldefaultrights IS 'Default menu access rights for each user level';

-- User Info Table
CREATE TABLE userinfo (
    userid INTEGER NOT NULL,
    hostname VARCHAR(20) NOT NULL DEFAULT '',
    abnormal_status VARCHAR(1) NOT NULL DEFAULT 'N',

    CONSTRAINT fk_userinfo_usermaster
        FOREIGN KEY (userid)
        REFERENCES usermaster(userid)
);

COMMENT ON TABLE userinfo IS 'Stores additional user session information';

-- Login Time Tracking Table
CREATE TABLE logintime (
    login_date      TIMESTAMP NOT NULL,
    userid          SMALLINT NOT NULL,
    login_time      VARCHAR(12) NOT NULL DEFAULT '',
    logout_time     VARCHAR(12) NOT NULL DEFAULT ''
);

COMMENT ON TABLE logintime IS 'Tracks user login and logout times for audit purposes';

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

CREATE INDEX idx_usermaster_username ON usermaster(susername);
CREATE INDEX idx_userrights_userid ON userrights(userid);
CREATE INDEX idx_logintime_userid ON logintime(userid);
CREATE INDEX idx_logintime_date ON logintime(login_date);
