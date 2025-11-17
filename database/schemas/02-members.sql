-- =====================================================
-- MEMBER MANAGEMENT TABLES
-- =====================================================
-- Description: Tables for member registration, profile, and categorization
-- Last Updated: November 2024
-- =====================================================

-- Member Master Table
CREATE TABLE member_master (
    mbno NUMERIC(18,0) PRIMARY KEY,
    prefix VARCHAR(5) NOT NULL DEFAULT '',
    f_name VARCHAR(100),
    m_name VARCHAR(50),
    l_name VARCHAR(50),
    sex VARCHAR(1) NOT NULL DEFAULT '',
    desig VARCHAR(40) NOT NULL DEFAULT '',
    present_address VARCHAR(200) NOT NULL DEFAULT '',
    permanent_address VARCHAR(200) NOT NULL DEFAULT '',
    wingno VARCHAR(6) NOT NULL DEFAULT '0',
    officeno INTEGER NOT NULL DEFAULT 0,
    age VARCHAR(2) NOT NULL DEFAULT '',
    dob TIMESTAMP,
    date_of_appt TIMESTAMP,
    dor TIMESTAMP,
    permanetdate TIMESTAMP,
    quasiperdate TIMESTAMP,
    supanuationdate TIMESTAMP,
    gross_salary NUMERIC(18,0) NOT NULL DEFAULT 0,
    basic_pay NUMERIC(18,0) NOT NULL DEFAULT 0,
    nominee_name VARCHAR(40) NOT NULL DEFAULT '',
    nominee_address VARCHAR(200) NOT NULL DEFAULT '',
    nominee_relation VARCHAR(25) NOT NULL DEFAULT '',
    declare_date TIMESTAMP,
    flg_retire VARCHAR(1) NOT NULL DEFAULT 'N',
    memb_date TIMESTAMP,
    pfno VARCHAR(10) NOT NULL DEFAULT '',
    lfno VARCHAR(10) NOT NULL DEFAULT '',
    flg_incometax VARCHAR(2) NOT NULL DEFAULT 'N',
    flg_insured CHAR(1) NOT NULL DEFAULT 'N',
    insureamt NUMERIC(18,0) NOT NULL DEFAULT 0,
    remarks VARCHAR(100) NOT NULL DEFAULT '',
    date_of_retirement TIMESTAMP,
    dept_name VARCHAR(50),
    cbsac VARCHAR(20),
    isactive CHAR(1)
);

COMMENT ON TABLE member_master IS 'Main member registration and profile information';
COMMENT ON COLUMN member_master.mbno IS 'Unique member number (Primary Key)';
COMMENT ON COLUMN member_master.prefix IS 'Title (Mr., Mrs., Ms., Dr.)';
COMMENT ON COLUMN member_master.wingno IS 'Wing/Branch number';
COMMENT ON COLUMN member_master.officeno IS 'Office/Division number';
COMMENT ON COLUMN member_master.flg_retire IS 'Retirement flag (Y/N)';
COMMENT ON COLUMN member_master.isactive IS 'Active status (Y/N)';

-- Member Master Delete History Table
CREATE TABLE member_masterdelete (
    mbno NUMERIC(18,0) NOT NULL,
    prefix VARCHAR(5) NOT NULL,
    f_name VARCHAR(50) NOT NULL,
    m_name VARCHAR(20) NOT NULL,
    l_name VARCHAR(20) NOT NULL,
    sex VARCHAR(1) NOT NULL,
    desig VARCHAR(40) NOT NULL,
    present_address VARCHAR(200) NOT NULL,
    permanent_address VARCHAR(200) NOT NULL,
    wingno VARCHAR(6) NOT NULL,
    officeno INTEGER NOT NULL,
    age VARCHAR(2) NOT NULL,
    dob TIMESTAMP NULL,
    date_of_appt TIMESTAMP NULL,
    dor TIMESTAMP NULL,
    permanetdate TIMESTAMP NULL,
    quasiperdate TIMESTAMP NULL,
    supanuationdate TIMESTAMP NULL,
    gross_salary NUMERIC(18,0) NOT NULL,
    basic_pay NUMERIC(18,0) NOT NULL,
    nominee_name VARCHAR(40) NOT NULL,
    nominee_address VARCHAR(200) NOT NULL,
    nominee_relation VARCHAR(25) NOT NULL,
    declare_date TIMESTAMP NULL,
    flg_retire VARCHAR(1) NOT NULL,
    memb_date TIMESTAMP NULL,
    pfno VARCHAR(10) NOT NULL,
    lfno VARCHAR(10) NOT NULL,
    flg_incometax VARCHAR(2) NOT NULL,
    flg_insured CHAR(1) NOT NULL,
    insureamt NUMERIC(18,0) NOT NULL,
    remarks VARCHAR(100) NOT NULL,
    deletedon TIMESTAMP NULL
);

COMMENT ON TABLE member_masterdelete IS 'Audit trail for deleted members';

-- Member Category Table
CREATE TABLE membercategory (
    mbno NUMERIC(18,0),
    categorycode INTEGER NOT NULL,
    membertype INTEGER DEFAULT 0
);

COMMENT ON TABLE membercategory IS 'Links members to their categories/types';

-- Member Type Master Table
CREATE TABLE membertypemaster (
    id SERIAL PRIMARY KEY,
    membertype VARCHAR(30) NOT NULL
);

COMMENT ON TABLE membertypemaster IS 'Defines member types (Regular, Associate, Honorary, etc.)';

-- Cast Category Master Table
CREATE TABLE castcategorymaster (
    id SERIAL PRIMARY KEY,
    castcategory VARCHAR(30) NOT NULL
);

COMMENT ON TABLE castcategorymaster IS 'Defines caste/category classifications';

-- Relation Master Table
CREATE TABLE relation_master (
    relation_id NUMERIC(18,0) NOT NULL,
    relation_name VARCHAR(20) NOT NULL,
    CONSTRAINT pk_relation_master PRIMARY KEY (relation_id)
);

COMMENT ON TABLE relation_master IS 'Defines relationship types (Father, Mother, Spouse, etc.)';

-- Wing Master Table
CREATE TABLE wingmast (
    wingno VARCHAR(6) PRIMARY KEY,
    wname VARCHAR(40) NOT NULL DEFAULT '',
    winstate SMALLINT NOT NULL DEFAULT 1
);

COMMENT ON TABLE wingmast IS 'Defines wings/branches of the organization';

-- Division Master Table
CREATE TABLE division_master (
    wingno VARCHAR(6) NOT NULL,
    officeno INTEGER GENERATED ALWAYS AS IDENTITY,
    divno INTEGER NOT NULL DEFAULT 0,
    name VARCHAR(200) NOT NULL DEFAULT '',
    address VARCHAR(200) NOT NULL DEFAULT '',
    city VARCHAR(20) NOT NULL DEFAULT 'NAGPUR',

    CONSTRAINT pk_division_master PRIMARY KEY (wingno, officeno),

    CONSTRAINT fk_division_master_wingmast
        FOREIGN KEY (wingno) REFERENCES wingmast(wingno)
);

COMMENT ON TABLE division_master IS 'Defines divisions/offices within wings';

-- Funds Master Table
CREATE TABLE funds_master (
    mbno            NUMERIC(18,0) PRIMARY KEY,
    mdamt           NUMERIC(8,2) NOT NULL DEFAULT 0,
    cdamt           NUMERIC(8,2) NOT NULL DEFAULT 0,
    shareamt        NUMERIC(8,2) NOT NULL DEFAULT 0,
    mdopbal         NUMERIC(8,2) NOT NULL DEFAULT 0,
    shareopbal      NUMERIC(8,2) NOT NULL DEFAULT 0,
    cdopbal         NUMERIC(8,2) NOT NULL DEFAULT 0,
    lnexecrec       NUMERIC(19,4),
    suspbal         NUMERIC(19,4)
);

COMMENT ON TABLE funds_master IS 'Tracks member fund balances (MD, CD, Share)';
COMMENT ON COLUMN funds_master.mdamt IS 'Membership Deposit amount';
COMMENT ON COLUMN funds_master.cdamt IS 'Compulsory Deposit amount';
COMMENT ON COLUMN funds_master.shareamt IS 'Share amount';

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

CREATE INDEX idx_member_master_name ON member_master(f_name, l_name);
CREATE INDEX idx_member_master_wing ON member_master(wingno, officeno);
CREATE INDEX idx_member_master_pfno ON member_master(pfno);
CREATE INDEX idx_member_master_active ON member_master(isactive);
CREATE INDEX idx_membercategory_mbno ON membercategory(mbno);
CREATE INDEX idx_funds_master_mbno ON funds_master(mbno);
