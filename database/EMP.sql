CREATE TABLE castcategorymaster (
    id SERIAL PRIMARY KEY,
    castcategory VARCHAR(30) NOT NULL
);




CREATE TABLE relation_master (
    relation_id NUMERIC(18,0) NOT NULL,
    relation_name VARCHAR(20) NOT NULL,
    CONSTRAINT pk_relation_master PRIMARY KEY (relation_id)
);




CREATE TABLE headtype (
    headtype VARCHAR(4) NOT NULL,
    ldtype VARCHAR(1) NOT NULL DEFAULT 'N',
    remark VARCHAR(30) NOT NULL DEFAULT '',
    woking_charges_flag CHAR(1) NOT NULL DEFAULT 'N',
    active_head_flag CHAR(1) NOT NULL DEFAULT 'Y',

    -- PRIMARY KEY (composite)
    CONSTRAINT pk_headtype PRIMARY KEY (headtype, ldtype),

    -- CHECK constraint (converted exactly)
    CONSTRAINT ck_headtype_ldtype
        CHECK (ldtype IN ('I', 'B', 'F', 'L', 'D', 'N'))
);




CREATE TABLE headmaster (
    code VARCHAR(5) NOT NULL,
    parent_code VARCHAR(5) NOT NULL DEFAULT '',
    hposition VARCHAR(12) NOT NULL DEFAULT '',
    head_name VARCHAR(100) NOT NULL DEFAULT '',
    interest VARCHAR(4) NOT NULL DEFAULT 'N',
    headtype VARCHAR(4) NOT NULL DEFAULT 'OTH',
    op_bal NUMERIC(19,4) NOT NULL DEFAULT 0,
    pflag VARCHAR(4) NOT NULL DEFAULT '',

    CONSTRAINT pk_headmaster PRIMARY KEY (code)
);



CREATE TABLE head_master (
    code VARCHAR(255),
    parent_code VARCHAR(255),
    hposition VARCHAR(255),
    head_name VARCHAR(255),
    interest VARCHAR(255),
    headtype VARCHAR(255),
    op_bal VARCHAR(255),
    pflag VARCHAR(255),
    gc VARCHAR(255)
);





CREATE TABLE operationmodemaster (
    operation_id BIGSERIAL PRIMARY KEY,
    description VARCHAR(25) NOT NULL
);




CREATE TABLE parameter_setting (
    param_code VARCHAR(30),
    param_value VARCHAR(50),
    param_desc VARCHAR(100)
);



CREATE TABLE main (
    maincode SMALLINT NOT NULL,
    mainname VARCHAR(25) NOT NULL,
    bankheadcode VARCHAR(6) NOT NULL
);




CREATE TABLE busrules (
    srno BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    appdate TIMESTAMP NOT NULL,

    rlnmaxloanamt NUMERIC(18,0) NOT NULL DEFAULT 75000,
    rlnrate NUMERIC(5,2) NOT NULL DEFAULT 12,
    rlnpenalrate NUMERIC(5,2) NOT NULL DEFAULT 0,
    rlnmaxnoinst NUMERIC(4,0) NOT NULL DEFAULT 0,
    rlnnogr NUMERIC(4,0) NOT NULL DEFAULT 0,

    elnmaxloanamt NUMERIC(18,0) NOT NULL DEFAULT 5000,
    elnrate NUMERIC(5,2) NOT NULL DEFAULT 12,
    elnmaxnoinst NUMERIC(4,0) NOT NULL DEFAULT 0,
    elnnogr NUMERIC(4,0) NOT NULL DEFAULT 0,

    alnmaxloanamt NUMERIC(18,0) NOT NULL DEFAULT 25000,
    alnrate NUMERIC(5,2) NOT NULL DEFAULT 12,
    alnmaxnoinst NUMERIC(4,0) NOT NULL DEFAULT 0,
    alnnogr NUMERIC(4,0) NOT NULL DEFAULT 0,

    mlnmaxloanamt NUMERIC(18,0) NOT NULL DEFAULT 1000,
    mlnrate NUMERIC(5,2) NOT NULL DEFAULT 12,
    mlnmaxnoinst NUMERIC(4,0) NOT NULL DEFAULT 0,
    mlnnogr NUMERIC(4,0) NOT NULL DEFAULT 0,

    minmembship NUMERIC(4,0) NOT NULL DEFAULT 0,
    workexp VARCHAR(10) NOT NULL DEFAULT '',
    sharerecov VARCHAR(20) NOT NULL DEFAULT '10',
    defaultduration SMALLINT NOT NULL DEFAULT 0,

    minshareamt NUMERIC(4,0) NOT NULL DEFAULT 0,
    maxshareamt NUMERIC(9,0) NOT NULL DEFAULT 0,
    minmdamt NUMERIC(5,0) NOT NULL DEFAULT 0,
    mincdamt NUMERIC(5,0) NOT NULL DEFAULT 0,
    maxcdamt NUMERIC(5,0) NOT NULL DEFAULT 0,

    edlmaxloanamt NUMERIC(18,0) NOT NULL DEFAULT 25000,
    edlrate NUMERIC(5,2) NOT NULL DEFAULT 10,
    edlpenalrate NUMERIC(5,2) NOT NULL DEFAULT 0,
    edlmaxnoinst NUMERIC(4,0) NOT NULL DEFAULT 36,
    edlnogr NUMERIC(4,0) NOT NULL DEFAULT 2,

    dataentryflag CHAR(1) DEFAULT 'N',
    print_demand_horizontal CHAR(1) DEFAULT 'Y',
    emi_based_demand CHAR(1) DEFAULT 'Y',
    minsavingbalance NUMERIC(9,0),
    working_exp_code VARCHAR(5),
    reducingbal_intt_calc VARCHAR(1) DEFAULT 'Y',
    intt_slot SMALLINT,

    flnmaxloanamt NUMERIC(18,0),
    flnmaxnoinst NUMERIC(18,0),
    flnnogr NUMERIC(18,0),
    flnpenalrate NUMERIC(18,0),
    flnrate NUMERIC(18,0),

    slnmaxloanamt NUMERIC(18,0),
    slnrate NUMERIC(18,0),
    slnmaxnoinst NUMERIC(18,0),
    slnnogr NUMERIC(18,0),

    loanmaxlimit NUMERIC(18,0),
    loanagainstbasic NUMERIC(18,0),
    loanagainstdeppercent NUMERIC(18,0),

    consolidateinttamountindemand VARCHAR(1),
    considerintt VARCHAR(1),
    exporttoexcel CHAR(1),
    visibleflag CHAR(1),
    profit_head_code CHAR(5)
);





CREATE TABLE wingmast (
    wingno VARCHAR(6) NOT NULL,
    wname VARCHAR(40) NOT NULL DEFAULT '',
    winstate SMALLINT NOT NULL DEFAULT 1,
    CONSTRAINT pk_wingmast PRIMARY KEY (wingno)
);







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






CREATE TABLE temp_division_master (
    wingno VARCHAR(6) NOT NULL,
    officeno SERIAL NOT NULL,
    divno INTEGER NOT NULL,
    name VARCHAR(200) NOT NULL,
    address VARCHAR(200) NOT NULL,
    city VARCHAR(20) NOT NULL,

    -- Optional primary key (recommended)
    PRIMARY KEY (officeno)
);






CREATE TABLE member_master (
    mbno NUMERIC(18,0) NOT NULL,
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
    isactive CHAR(1),

    CONSTRAINT pk_member_master PRIMARY KEY (mbno)
);


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
    isactive CHAR(1),

    CONSTRAINT fk_member_master_self
        FOREIGN KEY (mbno) REFERENCES member_master(mbno)
);





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






CREATE TABLE membercategory (
    mbno NUMERIC(18,0),
    categorycode INTEGER NOT NULL,
    membertype INTEGER DEFAULT 0
);





CREATE TABLE membertypemaster (
    id SERIAL PRIMARY KEY,
    membertype VARCHAR(30) NOT NULL
);









CREATE TABLE convertmember (
    accno NUMERIC(18,0),
    prefix VARCHAR(5),
    f_name VARCHAR(50),
    m_name VARCHAR(20),
    l_name VARCHAR(20)
);






CREATE TABLE suretymaster (
    mbno NUMERIC(18,0) NOT NULL,
    amount NUMERIC(19,4) NOT NULL DEFAULT 0,
    g1mbno NUMERIC(18,0) NOT NULL DEFAULT 0,
    g2mbno NUMERIC(18,0) NOT NULL DEFAULT 0,
    g1amt NUMERIC(19,4) NOT NULL DEFAULT 0,
    g2amt NUMERIC(19,4) NOT NULL DEFAULT 0,
    addflag CHAR(1) NOT NULL DEFAULT 'N',

    CONSTRAINT pk_suretymaster PRIMARY KEY (mbno)
);



CREATE TABLE guarrenter_mast (
    guarrenter_mbno VARCHAR(10),
    balance NUMERIC(19,4),
    openbalance NUMERIC(19,4)
);







CREATE TABLE fdmaster (
    mbno NUMERIC(18,0) NOT NULL,
    account_number BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    prefix VARCHAR(5) DEFAULT 'Mr',
    f_name VARCHAR(100) DEFAULT '',
    m_name VARCHAR(100) DEFAULT '',
    l_name VARCHAR(100) DEFAULT '',
    certno VARCHAR(10),
    depunit SMALLINT DEFAULT 2,
    depperiod NUMERIC(5,0) DEFAULT 0,
    rate NUMERIC(5,2),
    depdate TIMESTAMP,
    matdate TIMESTAMP,
    fdamount NUMERIC(18,0) DEFAULT 0 NOT NULL,
    matamount NUMERIC(18,2) DEFAULT 0 NOT NULL,
    interestbalance NUMERIC(18,2) DEFAULT 0 NOT NULL,
    interestpayamentmode SMALLINT DEFAULT 1 NOT NULL,
    interestamount NUMERIC(18,0) DEFAULT 0 NOT NULL,
    lastintpaydate TIMESTAMP,
    intpaid NUMERIC(18,2) DEFAULT 0 NOT NULL,
    status VARCHAR(1) DEFAULT '0' NOT NULL,
    statusdate TIMESTAMP,
    nominee VARCHAR(400) DEFAULT '',
    nage VARCHAR(100) DEFAULT '',
    naddr VARCHAR(800) DEFAULT '',
    nrelation VARCHAR(200) DEFAULT '',
    fdrdflag CHAR(1) DEFAULT 'F' NOT NULL,
    remarks VARCHAR(100) DEFAULT '',
    openbal NUMERIC(18,2) DEFAULT 0 NOT NULL,
    rd_by_demand VARCHAR(1),
    operationmode NUMERIC(4,0),
    intcalmethod INTEGER,
    refmbno INTEGER,
    minbal NUMERIC(18,2),

    CONSTRAINT pk_fdmaster PRIMARY KEY (mbno, account_number),

    -- CHECK constraint:
    CONSTRAINT ck_fdmaster_fdrdflag CHECK (fdrdflag IN ('R','F','S'))
);





CREATE TABLE fdmasterhistory (
    mbno NUMERIC(18,0) NOT NULL,
    account_number NUMERIC(18,0) NOT NULL,
    prefix VARCHAR(5) NOT NULL,
    f_name VARCHAR(50) NOT NULL,
    m_name VARCHAR(50) NOT NULL,
    l_name VARCHAR(50) NOT NULL,
    certno VARCHAR(10) NOT NULL,
    depunit SMALLINT NOT NULL,
    deppERiod NUMERIC(5,0) NOT NULL,
    rate NUMERIC(5,2) NOT NULL,
    depdate TIMESTAMP NOT NULL,
    matdate TIMESTAMP,
    fdamount NUMERIC(18,0) NOT NULL,
    matamount NUMERIC(18,2) NOT NULL,
    interestbalance NUMERIC(18,2) NOT NULL,
    interestpayamentmode SMALLINT NOT NULL,
    interestamount NUMERIC(18,0) NOT NULL,
    lastintpaydate TIMESTAMP,
    intpaid NUMERIC(18,2) NOT NULL,
    status VARCHAR(1) NOT NULL,
    statusdate TIMESTAMP,
    nominee VARCHAR(80) NOT NULL,
    nage VARCHAR(6) NOT NULL,
    naddr VARCHAR(100) NOT NULL,
    nrelation VARCHAR(25) NOT NULL,
    fdrdflag CHAR(1) NOT NULL,
    remarks VARCHAR(100) NOT NULL,
    openbal NUMERIC(18,2) NOT NULL,
    modifieddate TIMESTAMP
);



CREATE TABLE fdrd_slab_details (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fdrd CHAR(2) NOT NULL,
    scheme_code VARCHAR(4),
    from_amount NUMERIC(18,0),
    upto_amount NUMERIC(18,0),
    from_period NUMERIC(18,0),
    upto_period NUMERIC(18,0),
    period_unit VARCHAR(2),
    interest_rate NUMERIC(5,2),
    premature_interest_rate NUMERIC(5,2),
    applicable_from_date TIMESTAMP,
    applicable_upto_date TIMESTAMP
);




CREATE TABLE fdrdlienmaster (
    srno BIGSERIAL PRIMARY KEY,
    loancaseno NUMERIC(18,0),
    mbno NUMERIC(18,0) NOT NULL,
    fdrd_accountnumber NUMERIC(18,0) NOT NULL,
    fromdate TIMESTAMP,
    username VARCHAR(20)
);




CREATE TABLE fd_interest_master (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    interest_mst_id NUMERIC(18,0) NOT NULL,
    mbno NUMERIC(18,0) NOT NULL,
    account_number NUMERIC(18,0) NOT NULL,
    amount NUMERIC(18,2) NOT NULL,
    rate NUMERIC(18,2) NOT NULL,
    post CHAR(1) NOT NULL DEFAULT 'Y',
    posted CHAR(1) NOT NULL DEFAULT 'N',
    calc_from_date TIMESTAMP NULL,
    calc_to_date TIMESTAMP NULL,
    to_date TIMESTAMP NULL,
    from_date TIMESTAMP NULL,
    remarks VARCHAR(50) NULL,
    postdate TIMESTAMP NULL,
    vchrno VARCHAR(6) NULL,
    fdamount NUMERIC(18,0) NOT NULL DEFAULT 0
);




CREATE TABLE interestpaid (mpjint
    id NUMERIC(18,0) NOT NULL,
    mbno NUMERIC(18,0) NOT NULL,
    wrno VARCHAR(20) NOT NULL DEFAULT '',
    opbal NUMERIC(18,2) NOT NULL DEFAULT 0,
    totdr NUMERIC(18,2) NOT NULL DEFAULT 0,
    totcr NUMERIC(18,2) NOT NULL DEFAULT 0,
    closebal NUMERIC(18,2) NOT NULL DEFAULT 0,
    amount NUMERIC(19,4) NOT NULL DEFAULT 0,
    interest NUMERIC(19,4) NOT NULL DEFAULT 0,
    post VARCHAR(1) NOT NULL DEFAULT 'Y',
    paid VARCHAR(1) NOT NULL DEFAULT 'N',
    paydate TIMESTAMP NULL,
    vchrno VARCHAR(6) NOT NULL DEFAULT '',
    account_number NUMERIC(9,0) NULL,

    CONSTRAINT pk_interestpaid PRIMARY KEY (id, mbno)
);




CREATE TABLE bank_saving_product (
    account_number CHAR(14) NOT NULL,
    from_date TIMESTAMP NOT NULL,
    to_date TIMESTAMP NOT NULL,
    product NUMERIC(19,4) NOT NULL,
    posted CHAR(1),
    post_int CHAR(1),
    intramt NUMERIC(19,4),
    rateofintr NUMERIC(4,2)
);





CREATE TABLE bank_sbintcalverify (
    account_number CHAR(14),
    fromdate TIMESTAMP,
    todate TIMESTAMP,
    accode CHAR(4),
    caldate TIMESTAMP,
    remarks VARCHAR(40),
    source CHAR(1),
    intamt NUMERIC(7,2)
);






CREATE TABLE bank_saving_detail_product (
    account_number VARCHAR(14),
    product_date TIMESTAMP,
    product NUMERIC(19,4),
    total_product NUMERIC(19,4),
    intt_rate NUMERIC(4,2)
);




CREATE TABLE bank_saving_product (
    account_number CHAR(14) NOT NULL,
    from_date TIMESTAMP NOT NULL,
    to_date TIMESTAMP NOT NULL,
    product NUMERIC(19,4) NOT NULL,
    posted CHAR(1),
    post_int CHAR(1),
    intramt NUMERIC(19,4),
    rateofintr NUMERIC(4,2)
);




CREATE TABLE interestmaster (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inttype VARCHAR(3) NOT NULL DEFAULT '',
    frdt TIMESTAMP NULL,
    todt TIMESTAMP NULL,
    rate NUMERIC(19,4) NOT NULL DEFAULT 0
);






CREATE TABLE interestpaid (
    id NUMERIC(18,0) NOT NULL,
    mbno NUMERIC(18,0) NOT NULL,
    wrno VARCHAR(20) NOT NULL DEFAULT '',
    opbal NUMERIC(18,2) NOT NULL DEFAULT 0,
    totdr NUMERIC(18,2) NOT NULL DEFAULT 0,
    totcr NUMERIC(18,2) NOT NULL DEFAULT 0,
    closebal NUMERIC(18,2) NOT NULL DEFAULT 0,
    amount NUMERIC(19,4) NOT NULL DEFAULT 0,
    interest NUMERIC(19,4) NOT NULL DEFAULT 0,
    post VARCHAR(1) NOT NULL DEFAULT 'Y',
    paid VARCHAR(1) NOT NULL DEFAULT 'N',
    paydate TIMESTAMP NULL,
    vchrno VARCHAR(6) NOT NULL DEFAULT '',
    account_number NUMERIC(9,0) NULL,

    CONSTRAINT pk_interestpaid PRIMARY KEY (id, mbno),

    CONSTRAINT fk_interestpaid_interestmaster 
        FOREIGN KEY (id) REFERENCES interestmaster(id)
);






CREATE TABLE wingmast (
    wingno VARCHAR(6) PRIMARY KEY,
    wname VARCHAR(40) NOT NULL DEFAULT '',
    winstate SMALLINT NOT NULL DEFAULT 1
);



SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;


CREATE TABLE logintime (
    login_date      timestamp NOT NULL,
    userid          smallint NOT NULL,
    login_time      varchar(12) NOT NULL DEFAULT '',
    logout_time     varchar(12) NOT NULL DEFAULT ''
);


CREATE TABLE annualstatement (
    accno              numeric(18,0) NOT NULL,
    op_triftamt        numeric(18,0) NOT NULL,
    cur_triftamt       numeric(18,0) NOT NULL,
    cur_tfintrec       numeric(18,0) NOT NULL,
    op_tfintrec        numeric(18,0) NOT NULL,
    op_shareamt        numeric(18,0) NOT NULL,
    cur_shareamt       numeric(18,0) NOT NULL,
    op_wfamt           numeric(18,0) NOT NULL,
    cur_wfamt          numeric(18,0) NOT NULL,
    rlbalance          numeric(18,0) NOT NULL,
    tlbalance          numeric(18,0) NOT NULL
);



CREATE TABLE access_recovery (
    mbno              bigint       NOT NULL,
    acc_type          varchar(4)   NOT NULL,
    short_amount      numeric(19,4) NOT NULL DEFAULT 0,
    short_interest_amount numeric(19,4) NOT NULL DEFAULT 0,
    
    CONSTRAINT pk_access_recovery PRIMARY KEY (mbno, acc_type)
);



CREATE TABLE transactions (
    trans_no SERIAL NOT NULL,
    trans_type VARCHAR(2) NOT NULL,
    trans_date TIMESTAMP NOT NULL,
    mbno NUMERIC(18,0) NOT NULL DEFAULT 0,
    acc_no NUMERIC(18,0) NOT NULL DEFAULT 0,
    acc_type VARCHAR(4) NOT NULL DEFAULT 'OTH',
    trans_amt NUMERIC(18,2) NOT NULL DEFAULT 0,
    receipt_vchr_no VARCHAR(6) NOT NULL DEFAULT '',
    vchr_type VARCHAR(2) NOT NULL DEFAULT 'R',
    modeofpay VARCHAR(2) NOT NULL DEFAULT '',
    cheq_no VARCHAR(10) NOT NULL DEFAULT '',
    cheq_amt NUMERIC(18,2) NOT NULL DEFAULT 0,
    cheq_date TIMESTAMP NULL,
    bankname VARCHAR(75) NOT NULL DEFAULT '',
    pass_flag VARCHAR(1) NOT NULL DEFAULT 'N',
    cashier_flag VARCHAR(1) NOT NULL DEFAULT 'N',
    code VARCHAR(5) NOT NULL DEFAULT '',
    narration VARCHAR(100) NOT NULL DEFAULT '',
    username VARCHAR(50) NOT NULL DEFAULT '',
    cust_bank_name VARCHAR(100) NULL,

    CONSTRAINT pk_transactions PRIMARY KEY (trans_no, trans_date),

    CONSTRAINT ck_transactions_trans_type CHECK (trans_type IN ('DR','CR')),
    CONSTRAINT ck_transactions_vchr_type CHECK (vchr_type IN ('D','R','P','J')),
    CONSTRAINT ck_transactions_modeofpay CHECK (modeofpay IN ('','B','C','J'))
);




CREATE TABLE ledger (
    trans_no NUMERIC(18,0) NOT NULL,
    trans_date TIMESTAMP NOT NULL,
    trans_type VARCHAR(2) NOT NULL,
    code VARCHAR(5) NOT NULL,
    mbno NUMERIC(18,0) NOT NULL,
    acc_no NUMERIC(18,0) NOT NULL,
    acc_type VARCHAR(4) NOT NULL,
    trans_amt NUMERIC(19,4) NOT NULL DEFAULT 0,
    receipt_vchr_no VARCHAR(6) NOT NULL DEFAULT '',
    vchr_type VARCHAR(2) NOT NULL DEFAULT '',
    modeofpay VARCHAR(1) NOT NULL DEFAULT '',
    pl_balance NUMERIC(19,4) NOT NULL DEFAULT 0,
    narration VARCHAR(100) NOT NULL DEFAULT '',
    username VARCHAR(50) NOT NULL DEFAULT '',
    cust_bank_name VARCHAR(100)
);






CREATE TABLE dumm_1ledger (
  trans_no BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trans_date TIMESTAMP NOT NULL,
  trans_type VARCHAR(2) NOT NULL,
  code VARCHAR(5) NOT NULL,
  mbno NUMERIC(18,0) NOT NULL,
  acc_no NUMERIC(18,0) NOT NULL,
  acc_type VARCHAR(4) NOT NULL,
  trans_amt NUMERIC(18,2),
  receipt_vchr_no VARCHAR(6) NOT NULL,
  vchr_type VARCHAR(2) NOT NULL,
  modeofpay VARCHAR(1) NOT NULL,
  pl_balance NUMERIC(18,2) NOT NULL,
  narration VARCHAR(500),
  username VARCHAR(50) NOT NULL,
  cust_bank_name VARCHAR(100)
);







CREATE TABLE voucher_master (
    p_vchr_no VARCHAR(6) NOT NULL DEFAULT '',
    r_vchr_no VARCHAR(6) NOT NULL DEFAULT '',
    j_vchr_no VARCHAR(6) NOT NULL DEFAULT '',
    d_vchr_no VARCHAR(6) NOT NULL DEFAULT ''
);




CREATE TABLE daily_gl_history (
    trans_date TIMESTAMP NOT NULL,
    code VARCHAR(6) NOT NULL,
    balance NUMERIC(19,4) NOT NULL DEFAULT 0,
    
    CONSTRAINT pk_daily_gl_history PRIMARY KEY (trans_date, code)
);


CREATE TABLE balancesheet (
    head_code VARCHAR(5) NOT NULL,
    parent_code VARCHAR(5) NOT NULL DEFAULT '',
    head_name VARCHAR(75) NOT NULL DEFAULT '',
    opening_balance NUMERIC(19,4) NOT NULL DEFAULT 0,
    debit NUMERIC(19,4) NOT NULL DEFAULT 0,
    credit NUMERIC(19,4) NOT NULL DEFAULT 0,
    closingbalance NUMERIC(19,4) NOT NULL DEFAULT 0,
    closingbal_db NUMERIC(19,4) NOT NULL DEFAULT 0,
    closing_cr NUMERIC(19,4) NOT NULL DEFAULT 0,
    maincd SMALLINT DEFAULT 0,

    CONSTRAINT pk_balancesheet PRIMARY KEY (head_code)
);




CREATE TABLE balsheet (
    head_code VARCHAR(5) NOT NULL,
    parent_code VARCHAR(5) NOT NULL,
    head_name VARCHAR(75) NOT NULL,
    opening_balance NUMERIC(19,4) NOT NULL,
    debit NUMERIC(19,4) NOT NULL,
    credit NUMERIC(19,4) NOT NULL,
    closingbalance NUMERIC(19,4) NOT NULL,
    closingbal_db NUMERIC(19,4) NOT NULL,
    closing_cr NUMERIC(19,4) NOT NULL,
    maincd SMALLINT
);




CREATE TABLE pl2bsac (
    maincode SMALLINT NOT NULL,
    accode VARCHAR(5) NOT NULL,
    bankheadcode VARCHAR(4)
);





CREATE TABLE pivot (
    year smallint,
    quarter smallint,
    amount numeric(18,2)
);



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



CREATE TABLE userlevelmaster (
    userlevelid SMALLINT NOT NULL,
    userlevel VARCHAR(20) NOT NULL DEFAULT '',
    CONSTRAINT pk_userlevelmaster PRIMARY KEY (userlevelid)
);




CREATE TABLE menumaster (
    menuid INTEGER NOT NULL,
    menuname VARCHAR(50) NOT NULL DEFAULT '',
    menudesc VARCHAR(50) NOT NULL DEFAULT '',
    visibleflag CHAR(1),

    CONSTRAINT pk_menumaster PRIMARY KEY (menuid)
);





CREATE TABLE userinfo (
    userid INTEGER NOT NULL,
    hostname VARCHAR(20) NOT NULL DEFAULT '',
    abnormal_status VARCHAR(1) NOT NULL DEFAULT 'N',

    CONSTRAINT fk_userinfo_usermaster
        FOREIGN KEY (userid)
        REFERENCES usermaster(userid)
);





CREATE TABLE userleveldefaultrights (
    userlevelid SMALLINT NOT NULL,
    menuid INTEGER NOT NULL,

    CONSTRAINT pk_userleveldefaultrights PRIMARY KEY (userlevelid, menuid),

    CONSTRAINT fk_userleveldefaultrights_menu
        FOREIGN KEY (menuid) REFERENCES menumaster(menuid),

    CONSTRAINT fk_userleveldefaultrights_userlevel
        FOREIGN KEY (userlevelid) REFERENCES userlevelmaster(userlevelid)
);




CREATE TABLE temp_alm (
    cn NUMERIC(7,0) NOT NULL,
    at NUMERIC(3,0) NOT NULL,
    ac NUMERIC(6,0) NOT NULL,
    an VARCHAR(50),
    dd TIMESTAMP,
    fd TIMESTAMP,
    ni NUMERIC(4,0),
    ld TIMESTAMP,
    la NUMERIC(25,2),
    ia NUMERIC(25,2),
    ri NUMERIC(25,2),
    ai NUMERIC(25,2),
    rt VARCHAR(1),
    pc VARCHAR(3),
    wc VARCHAR(1),
    ws VARCHAR(3),
    sc VARCHAR(3),
    sd VARCHAR(15),
    sa NUMERIC(25,2),
    id TIMESTAMP,
    ip NUMERIC(25,2),
    ma NUMERIC(25,2),
    sb VARCHAR(1),
    bn VARCHAR(2),
    bd TIMESTAMP,
    np VARCHAR(1),
    hc VARCHAR(2),
    ovdt TIMESTAMP,
    uid1 VARCHAR(3),
    oid VARCHAR(3),
    gac1 NUMERIC(7,0),
    gac2 NUMERIC(7,0),
    gac3 NUMERIC(7,0),
    ide NUMERIC(10,0),
    sal NUMERIC(25,2),
    rb VARCHAR(3)
);



CREATE TABLE temp_rd (
    cn numeric(7,0),
    at numeric(3,0) NOT NULL,
    ac numeric(6,0) NOT NULL,
    rn varchar(10),
    rd timestamp,
    rt varchar(1),
    rp numeric(25,2),
    rs varchar(1),
    ri numeric(25,2),
    ramt numeric(25,2),
    mamt numeric(25,2),
    md timestamp,
    ipm varchar(1),
    uid1 varchar(3),
    oid varchar(3),
    fdp varchar(1),
    ipt varchar(1),
    ed timestamp,
    ei numeric(25,2),
    eamt numeric(25,2),
    esn numeric(5,0)
);



CREATE TABLE temp_fd (
    cn numeric(7,0),
    at numeric(3,0) NOT NULL,
    ac numeric(6,0) NOT NULL,
    rn varchar(10),
    rd timestamp,
    rt varchar(1),
    rp numeric(25,2),
    rs varchar(1),
    ri numeric(25,2),
    ramt numeric(25,2),
    mamt numeric(25,2),
    md timestamp,
    ipm varchar(1),
    uid1 varchar(3),
    oid varchar(3),
    fdp varchar(1),
    ipt varchar(1),
    ed timestamp,
    ei numeric(25,2),
    eamt numeric(25,2),
    esn numeric(5,0)
);





CREATE TABLE loan_limit_master (
    loan_limit_id BIGSERIAL PRIMARY KEY,
    code VARCHAR(5) UNIQUE
);



CREATE TABLE userrights (
    userid INTEGER NOT NULL,
    menuid INTEGER NOT NULL,
    PRIMARY KEY (userid, menuid),
    FOREIGN KEY (userid) REFERENCES usermaster(userid),
    FOREIGN KEY (menuid) REFERENCES menumaster(menuid)
);



CREATE TABLE society_details (
    name            varchar(100) NOT NULL,
    address         varchar(100) NOT NULL DEFAULT '',
    regno           varchar(20)  NOT NULL DEFAULT '',
    phone1          varchar(50)  NOT NULL DEFAULT '',
    phone2          varchar(50)  NOT NULL DEFAULT '',
    fax             varchar(50)  NOT NULL DEFAULT '',
    week_holiday    varchar(10)  NOT NULL DEFAULT '',
    authshare       numeric(19,4) NOT NULL DEFAULT 0
);








CREATE TABLE getworkingdate (
    working_date      timestamp NOT NULL,
    payment_voucher   smallint  NOT NULL DEFAULT 0,
    receipt_voucher   smallint  NOT NULL DEFAULT 0,
    journal_voucher   smallint  NOT NULL DEFAULT 0,
    dayend_flag       varchar(1) NOT NULL DEFAULT 'N',
    updategl_flag     varchar(1) NOT NULL DEFAULT 'N'
);





CREATE TABLE jointmaster (
    joint_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mbno            BIGINT NOT NULL,
    account_number  BIGINT NOT NULL,
    name            VARCHAR(50) NOT NULL,
    address         VARCHAR(75),

    CONSTRAINT fk_jointmaster_fdmaster
        FOREIGN KEY (mbno, account_number)
        REFERENCES fdmaster (mbno, account_number)
);




CREATE TABLE funds_master (
    mbno            numeric(18,0) PRIMARY KEY,
    mdamt           numeric(8,2) NOT NULL DEFAULT 0,
    cdamt           numeric(8,2) NOT NULL DEFAULT 0,
    shareamt        numeric(8,2) NOT NULL DEFAULT 0,
    mdopbal         numeric(8,2) NOT NULL DEFAULT 0,
    shareopbal      numeric(8,2) NOT NULL DEFAULT 0,
    cdopbal         numeric(8,2) NOT NULL DEFAULT 0,
    lnexecrec       numeric(19,4),
    suspbal         numeric(19,4)
);


CREATE TABLE bankopbal (
    trfid integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fycode integer,
    headcode varchar(5),
    parentcode varchar(5),
    closingbalance numeric(19,4)
);



CREATE TABLE yearend (
    yearcode SERIAL PRIMARY KEY,
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    username VARCHAR(40) NOT NULL DEFAULT ''
);



CREATE TABLE yearend_head (
    yearcode        numeric(18,0) NOT NULL,
    head_code       varchar(5) NOT NULL,
    parent_code     varchar(5) NOT NULL DEFAULT '',
    closing_bal     numeric(18,0) NOT NULL DEFAULT 0,
    PRIMARY KEY (yearcode, head_code)
);


CREATE TABLE yearend_member (
    yearcode smallint,
    acc_type varchar(4),
    mbno varchar(10),
    balance numeric(19,4)
);





CREATE TABLE loan_master (
    mbno              numeric(18,0) NOT NULL,
    loantype          varchar(3)    NOT NULL,
    loancaseno        numeric(18,0) NOT NULL,
    loan_amt          numeric(19,4) NOT NULL DEFAULT 0,
    payment_date      timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    rate              numeric(19,4) NOT NULL DEFAULT 0,
    no_of_instal      smallint      NOT NULL DEFAULT 0,
    instal_amt        numeric(19,4) NOT NULL DEFAULT 0,
    balance           numeric(19,4) NOT NULL DEFAULT 0,
    openbalance       numeric(19,4) NOT NULL DEFAULT 0,
    purpose           varchar(50)   NOT NULL DEFAULT '',
    intt_amount       numeric(14,2),
    penalrate         numeric(10,2) NOT NULL DEFAULT 0,

    PRIMARY KEY (mbno, loantype, loancaseno)
);






CREATE TABLE loan_masterhistory (
    mbno              numeric(18,0) NOT NULL,
    loantype          varchar(3) NOT NULL,
    loancaseno        numeric(18,0) NOT NULL,
    loan_amt          numeric(18,2) NOT NULL,
    payment_date      timestamp NOT NULL,
    rate              numeric(18,2) NOT NULL,
    no_of_instal      smallint NOT NULL,
    instal_amt        numeric(18,2) NOT NULL,
    balance           numeric(18,2) NOT NULL,
    openbalance       numeric(18,2) NOT NULL,
    purpose           varchar(50) NOT NULL,
    rowid             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    intt_amount       numeric(14,2),
    penalrate         numeric(10,2) DEFAULT 0
);



CREATE TABLE loan_nominee (
    srno        bigserial PRIMARY KEY,
    loancaseno  bigint NOT NULL,
    name        varchar(50) NOT NULL,
    address     varchar(50),
    age         smallint,
    relation    varchar(25)
);



CREATE TABLE loan_pending (
    loancaseno      bigserial NOT NULL,
    mbno            numeric(18,0) NOT NULL,
    loantype        varchar(3) NOT NULL,
    applied_amt     numeric(18,2) NOT NULL DEFAULT 0,
    sanctioned_amt  numeric(18,2) NOT NULL DEFAULT 0,
    app_date        timestamp NULL,
    sanctioned_date timestamp NULL,
    no_of_instal    smallint NOT NULL DEFAULT 60,
    g1mbno          numeric(18,0) NOT NULL DEFAULT 0,
    g2mbno          numeric(18,0) NOT NULL DEFAULT 0,
    g3mbno          numeric(18,0) NOT NULL DEFAULT 0,
    purpose         varchar(50) NOT NULL DEFAULT '',
    flg_sanctioned  varchar(1) NOT NULL DEFAULT 'N',
    flg_paid        varchar(1) NOT NULL DEFAULT 'N',
    form_number     varchar(10) NULL,

    PRIMARY KEY (loancaseno, mbno)
);




CREATE TABLE demand_master (
    demand_for_year       integer NOT NULL,
    demand_for_month      smallint NOT NULL,
    mbno                  numeric(18,0) NOT NULL,
    demand_posted         varchar(1) NOT NULL,
    rln_amount            numeric(18,2) NOT NULL,
    eln_amount            numeric(18,2) NOT NULL,
    aln_amount            numeric(18,2) NOT NULL,
    mln_amount            numeric(18,2) NOT NULL,
    rln_installment_amount numeric(18,2) NOT NULL,
    rln_interest          numeric(18,2) NOT NULL,
    eln_installment_amount numeric(18,2) NOT NULL,
    eln_interest          numeric(18,2) NOT NULL,
    aln_installment_amount numeric(18,2) NOT NULL,
    aln_interest          numeric(18,2) NOT NULL,
    mln_installment_amount numeric(18,2) NOT NULL,
    mln_interest          numeric(18,2) NOT NULL,
    rd_amount             numeric(18,2) NOT NULL,
    md_amount             numeric(18,2) NOT NULL,
    cd_amount             numeric(18,2) NOT NULL,
    shr_amount            numeric(18,2) NOT NULL,
    bankcharge            numeric(18,2) NOT NULL,
    sd                    varchar(1) NOT NULL,
    balance_for_month     numeric(18,2) NOT NULL,
    dmnd_gnrt_date        timestamp NULL,
    officeno              integer NOT NULL,
    totaldemand           numeric(18,2) NOT NULL,
    others                numeric(18,2) NOT NULL,
    rdbalance             numeric(18,2) NOT NULL,
    mdbalance             numeric(18,2) NOT NULL,
    cdbalance             numeric(18,2) NOT NULL,
    shrbalance            numeric(18,2) NOT NULL,
    receipt_vchr_no       varchar(6) NOT NULL,
    dmnd_post_date        timestamp NULL,
    passflag              varchar(1) NOT NULL,
    dmnd_srno             integer NOT NULL,
    edl_amount            numeric(18,2) NOT NULL,
    edl_installment_amount numeric(18,2) NOT NULL,
    edl_interest          numeric(18,2) NOT NULL,
    loancaseno            integer NULL,
    fln_amount            numeric(18,2),
    fln_installment_amount numeric(18,2),
    fln_interest          numeric(18,2),

    PRIMARY KEY (demand_for_year, demand_for_month, mbno)
);




CREATE TABLE demand_masterdelete (
    demand_for_year          integer NOT NULL,
    demand_for_month         smallint NOT NULL,
    mbno                     numeric(18,0) NOT NULL,
    demand_posted            varchar(1) NOT NULL DEFAULT 'N',
    rln_amount               numeric(18,2) NOT NULL DEFAULT 0,
    eln_amount               numeric(18,2) NOT NULL DEFAULT 0,
    aln_amount               numeric(18,2) NOT NULL DEFAULT 0,
    mln_amount               numeric(18,2) NOT NULL DEFAULT 0,
    rln_installment_amount   numeric(18,2) NOT NULL DEFAULT 0,
    rln_interest             numeric(18,2) NOT NULL DEFAULT 0,
    eln_installment_amount   numeric(18,2) NOT NULL DEFAULT 0,
    eln_interest             numeric(18,2) NOT NULL DEFAULT 0,
    aln_installment_amount   numeric(18,2) NOT NULL DEFAULT 0,
    aln_interest             numeric(18,2) NOT NULL DEFAULT 0,
    mln_installment_amount   numeric(18,2) NOT NULL DEFAULT 0,
    mln_interest             numeric(18,2) NOT NULL DEFAULT 0,
    rd_amount                numeric(18,2) NOT NULL DEFAULT 0,
    md_amount                numeric(18,2) NOT NULL DEFAULT 0,
    cd_amount                numeric(18,2) NOT NULL DEFAULT 0,
    shr_amount               numeric(18,2) NOT NULL DEFAULT 0,
    bankcharge               numeric(18,2) NOT NULL DEFAULT 0,
    sd                       varchar(1) NOT NULL DEFAULT 'N',
    balance_for_month        numeric(18,2) NOT NULL DEFAULT 0,
    dmnd_gnrt_date           timestamp NULL,
    officeno                 integer NOT NULL DEFAULT 0,
    totaldemand              numeric(18,2) NOT NULL DEFAULT 0,
    others                   numeric(18,2) NOT NULL DEFAULT 0,
    rdbalance                numeric(18,2) NOT NULL DEFAULT 0,
    mdbalance                numeric(18,2) NOT NULL DEFAULT 0,
    cdbalance                numeric(18,2) NOT NULL DEFAULT 0,
    shrbalance               numeric(18,2) NOT NULL DEFAULT 0,
    receipt_vchr_no          varchar(6) NOT NULL DEFAULT '',
    dmnd_post_date           timestamp NULL,
    passflag                 varchar(1) NOT NULL DEFAULT 'N',
    dmnd_srno                integer NOT NULL DEFAULT 0,
    deletedon                timestamp NULL,
    edl_amount               numeric(18,2) NOT NULL DEFAULT 0,
    edl_installment_amount   numeric(18,2) NOT NULL DEFAULT 0,
    edl_interest             numeric(18,2) NOT NULL DEFAULT 0
);




CREATE TABLE demandprintorder (
    row_id      bigserial PRIMARY KEY,
    code        varchar(6),
    headtype    varchar(4),
    interest    varchar(4),
    description varchar(20),
    map_demand_columnname varchar(40),
    printorder  integer
);




CREATE TABLE demand_receipt (
    trans_no              SERIAL PRIMARY KEY,
    trans_date            timestamp NOT NULL,
    mbno                  numeric(18,0) NOT NULL DEFAULT 0,
    dyear                 int NOT NULL DEFAULT 0,
    dmonth                smallint NOT NULL DEFAULT 0,
    code                  varchar(5) NOT NULL DEFAULT '',
    trans_type            varchar(2) NOT NULL,
    acc_no                int NOT NULL DEFAULT 0,
    acc_type              varchar(4) NOT NULL DEFAULT 'OTH',
    trans_amt             numeric(18,2) NOT NULL DEFAULT 0,
    receipt_vchr_no       varchar(6) NOT NULL DEFAULT '',
    vchr_type             varchar(2) NOT NULL DEFAULT 'R',
    modeofpay             varchar(2) NOT NULL DEFAULT '',
    cheq_no               varchar(10) NOT NULL DEFAULT '',
    cheq_amt              numeric(18,2) NOT NULL DEFAULT 0,
    cheq_date             timestamp NULL,
    bankname              varchar(75) NOT NULL DEFAULT '',
    pass_flag             varchar(1) NOT NULL DEFAULT 'N',
    cashier_flag          varchar(1) NOT NULL DEFAULT 'N',
    narration             varchar(100) NOT NULL DEFAULT '',
    username              varchar(50) NOT NULL DEFAULT '',

    CONSTRAINT ck_demand_receipt_transtype 
        CHECK (trans_type IN ('DR','CR')),

    CONSTRAINT ck_demand_receipt_vchrtype 
        CHECK (vchr_type IN ('D','R','P','J')),

    CONSTRAINT ck_demand_receipt_modeofpay 
        CHECK (modeofpay IN ('', 'B','C','J')),

    CONSTRAINT uq_demand_receipt UNIQUE (
        dyear, dmonth, trans_date, mbno, code, acc_no
    )
);




CREATE TABLE demandbyhand (
    demand_for_year        integer NOT NULL,
    demand_for_month       smallint NOT NULL,
    mbno                   numeric(18,0) NOT NULL,
    demand_posted          varchar(1) NOT NULL DEFAULT 'N',
    rln_amount             numeric(18,2) NOT NULL DEFAULT 0,
    tln_amount             numeric(18,2) NOT NULL DEFAULT 0,
    rln_installment_amount numeric(18,2) NOT NULL DEFAULT 0,
    rln_interest           numeric(18,2) NOT NULL DEFAULT 0,
    tln_installment_amount numeric(18,2) NOT NULL DEFAULT 0,
    tln_interest           numeric(18,2) NOT NULL DEFAULT 0,
    tf_amount              numeric(18,2) NOT NULL DEFAULT 0,
    wf_amount              numeric(18,2) NOT NULL DEFAULT 0,
    shr_amount             numeric(18,2) NOT NULL DEFAULT 0,
    sd                     varchar(1) NOT NULL DEFAULT 'N',
    balance_for_month      numeric(18,2) NOT NULL DEFAULT 0,
    dmnd_gnrt_date         timestamp NULL,
    officeno               integer NOT NULL DEFAULT 0,
    totaldemand            numeric(18,2) NOT NULL DEFAULT 0,
    others                 numeric(18,2) NOT NULL DEFAULT 0,
    receipt_vchr_no        varchar(6) NOT NULL DEFAULT '',
    dmnd_post_date         timestamp NULL,
    passflag               varchar(1) NOT NULL DEFAULT 'N',
    dmnd_srno              integer NOT NULL DEFAULT 0,
    username               varchar(50) NOT NULL DEFAULT '',
    
    CONSTRAINT pk_demandbyhand PRIMARY KEY (demand_for_year, demand_for_month, mbno)
);



CREATE TABLE demandbyhanddeleted (
    demand_for_year        int NOT NULL,
    demand_for_month       smallint NOT NULL,
    mbno                   numeric(18,0) NOT NULL,
    demand_posted          varchar(1) NOT NULL DEFAULT 'N',
    rln_amount             numeric(18,2) NOT NULL DEFAULT 0,
    tln_amount             numeric(18,2) NOT NULL DEFAULT 0,
    rln_installment_amount numeric(18,2) NOT NULL DEFAULT 0,
    rln_interest           numeric(18,2) NOT NULL DEFAULT 0,
    tln_installment_amount numeric(18,2) NOT NULL DEFAULT 0,
    tln_interest           numeric(18,2) NOT NULL DEFAULT 0,
    tf_amount              numeric(18,2) NOT NULL DEFAULT 0,
    wf_amount              numeric(18,2) NOT NULL DEFAULT 0,
    shr_amount             numeric(18,2) NOT NULL DEFAULT 0,
    sd                     varchar(1) NOT NULL DEFAULT 'N',
    balance_for_month      numeric(18,2) NOT NULL DEFAULT 0,
    dmnd_gnrt_date         timestamp NULL,
    officeno               int NOT NULL DEFAULT 0,
    totaldemand            numeric(18,2) NOT NULL DEFAULT 0,
    others                 numeric(18,2) NOT NULL DEFAULT 0,
    receipt_vchr_no        varchar(6) NOT NULL DEFAULT '',
    dmnd_post_date         timestamp NULL,
    passflag               varchar(1) NOT NULL DEFAULT 'N',
    dmnd_srno              int NOT NULL DEFAULT 0,
    username               varchar(50) NOT NULL DEFAULT '',
    narration              varchar(100) NOT NULL DEFAULT '',
    deletedon              timestamp NULL
);





CREATE TABLE mpjint (
    id              bigint NOT NULL,
    mbno            bigint NOT NULL,
    wrno            varchar(20) NOT NULL,
    opbal           numeric(18,2) NOT NULL,
    totdr           numeric(18,2) NOT NULL,
    totcr           numeric(18,2) NOT NULL,
    closebal        numeric(18,2) NOT NULL,
    amount          numeric(19,4) NOT NULL,
    interest        numeric(19,4) NOT NULL,
    post            varchar(1) NOT NULL,
    paid            varchar(1) NOT NULL,
    paydate         timestamp NULL,
    vchrno          varchar(6) NOT NULL,

    CONSTRAINT pk_mpjint PRIMARY KEY (id)
);




CREATE TABLE akola_national (
    mbno              double precision,
    name              varchar(255),
    pfno              double precision,
    wingno            double precision,
    officeno          double precision,
    share_amt         double precision,
    rd                varchar(255),
    prev_lt           double precision,
    lt                double precision,
    field10           double precision,
    field11           double precision,
    prev_st           double precision,
    st                double precision,
    field14           double precision,
    field15           double precision
);


CREATE TABLE akola_united (
    mbno double precision,
    name varchar(255),
    pfno double precision,
    wingno double precision,
    officeno double precision,
    share double precision,
    rd varchar(255),
    prev_lt double precision,
    lt double precision,
    field10 double precision,
    field11 double precision,
    prev_st double precision,
    st double precision,
    field14 double precision,
    field15 double precision
);



CREATE TABLE amravati_national (
    mbno              double precision,
    name              varchar(255),
    pfno              double precision,
    wingno            double precision,
    officeno          double precision,
    share             double precision,
    rd                double precision,
    prev_lt           double precision,
    lt                double precision,
    field10           double precision,
    field11           double precision,
    prev_st           double precision,
    st                double precision,
    field14           double precision,
    field15           double precision
);




CREATE TABLE amravati_united (
    mbno double precision,
    name varchar(255),
    pfno double precision,
    wingno double precision,
    officeno double precision,
    share double precision,
    rd double precision,
    prev_lt double precision,
    lt double precision,
    field10 double precision,
    field11 double precision,
    prev_st double precision,
    st double precision,
    field14 double precision,
    field15 double precision
);



CREATE TABLE aurangabad_unitd (
    mbno              double precision,
    name              varchar(255),
    pfno              double precision,
    wingno            double precision,
    officeno          double precision,
    share             double precision,
    rd                varchar(255),
    "PREV LT"         double precision,
    lt                double precision,
    field10           double precision,
    field11           double precision,
    "PREV ST"         double precision,
    st                double precision,
    field14           double precision,
    field15           double precision
);



CREATE TABLE jalgaon_united (
    mbno              double precision,
    name              varchar(255),
    pfno              double precision,
    wingno            double precision,
    officeno          double precision,
    share             double precision,
    rd                double precision,
    prev_lt           double precision,
    lt                double precision,
    field10           double precision,
    field11           double precision,
    prev_st           double precision,
    st                double precision,
    field14           double precision,
    field15           double precision
);


CREATE TABLE nanded_united (
    mbno              double precision,
    name              varchar(255),
    pfno              double precision,
    wingno            double precision,
    officeno          double precision,
    share             double precision,
    rd                double precision,
    "PREV LT"         double precision,
    lt                double precision,
    field10           double precision,
    field11           double precision,
    "PREV ST"         double precision,
    st                double precision,
    field14           double precision,
    field15           double precision
);



CREATE TABLE ro_national (
    mbno double precision,
    name varchar(255),
    pfno double precision,
    wingno double precision,
    officeno double precision,
    share double precision,
    rd double precision,
    prev_lt double precision,
    lt double precision,
    field10 double precision,
    field11 double precision,
    prev_st double precision,
    st double precision,
    field14 double precision,
    field15 double precision
);



CREATE TABLE ro_united (
    mbno               double precision,
    name               varchar(255),
    pfno               double precision,
    wingno             double precision,
    officeno           double precision,
    share              double precision,
    rd                 double precision,
    prev_lt            double precision,
    lt                 double precision,
    field10            double precision,
    field11            double precision,
    prev_st            double precision,
    st                 double precision,
    field14            double precision,
    field15            double precision
);




CREATE TABLE doi_national (
    mbno             double precision,
    name             varchar(255),
    pfno             double precision,
    wingno           double precision,
    officeno         double precision,
    share            double precision,
    rd               double precision,
    prev_lt          double precision,
    lt               double precision,
    field10          double precision,
    field11          double precision,
    prev_st          double precision,
    st               double precision,
    field14          double precision,
    field15          double precision
);



CREATE TABLE doi_united (
    mbno            double precision NULL,
    name            varchar(255) NULL,
    pfno            double precision NULL,
    wingno          double precision NULL,
    officeno        double precision NULL,
    share           double precision NULL,
    rd              double precision NULL,
    "PREV LT"       double precision NULL,
    lt              double precision NULL,
    field10         double precision NULL,
    field11         double precision NULL,
    "PREV ST"       double precision NULL,
    st              double precision NULL,
    field14         double precision NULL,
    field15         double precision NULL
);


CREATE TABLE doii_national (
    mbno               double precision,
    name               varchar(255),
    pfno               double precision,
    wingno             double precision,
    officeno           double precision,
    share              double precision,
    rd                 double precision,
    "PREV LT"          double precision,
    lt                 double precision,
    field10            double precision,
    field11            double precision,
    "PREV ST"          double precision,
    st                 double precision,
    field14            double precision,
    field15            double precision
);



CREATE TABLE doii_united (
    mbno              double precision,
    name              varchar(255),
    folio             double precision,
    wingno            double precision,
    officeno          double precision,
    share             double precision,
    rd                double precision,
    prev_lt           double precision,
    lt                double precision,
    field10           double precision,
    field11           double precision,
    prev_st           double precision,
    st                double precision,
    field14           double precision,
    field15           double precision
);




CREATE TABLE doiii_national (
    mbno               double precision,
    name               varchar(255),
    pfno               double precision,
    wingno             double precision,
    officeno           double precision,
    share              double precision,
    rd                 double precision,
    "PREV LT"          double precision,
    lt                 double precision,
    field10            double precision,
    field11            double precision,
    "PREV ST"          double precision,
    st                 double precision,
    field14            double precision,
    field15            double precision
);







CREATE TABLE doiv_national (
    mbno              double precision,
    name              varchar(255),
    pfno              double precision,
    wingno            double precision,
    officeno          double precision,
    share             double precision,
    rd                double precision,
    prev_lt           double precision,
    lt                double precision,
    field10           double precision,
    field11           double precision,
    prev_st           double precision,
    st                double precision,
    field14           double precision,
    field15           double precision
);





CREATE TABLE dov_national (
    mbno double precision,
    name varchar(255),
    pfno double precision,
    wingno double precision,
    officeno double precision,
    share double precision,
    rd double precision,
    prev_lt double precision,
    lt double precision,
    field10 double precision,
    field11 double precision,
    prev_st double precision,
    st double precision,
    field14 double precision,
    field15 double precision
);





CREATE TABLE oic1 (
    mbno            double precision,
    name            varchar(255),
    pfno            double precision,
    wingno          double precision,
    officeno        double precision,
    share           double precision,
    rd              double precision,
    prev_lt         double precision,
    lt              double precision,
    field10         double precision,
    field11         double precision,
    prev_st         double precision,
    st              double precision,
    field14         double precision,
    field15         double precision
);




CREATE TABLE oic2 (
    mbno double precision NULL,
    name varchar(255) NULL,
    pfno double precision NULL,
    wingno double precision NULL,
    officeno double precision NULL,
    share double precision NULL,
    rd double precision NULL,
    prev_lt double precision NULL,
    lt double precision NULL,
    field10 double precision NULL,
    field11 double precision NULL,
    prev_st double precision NULL,
    st double precision NULL,
    field14 double precision NULL,
    field15 double precision NULL
);



CREATE TABLE oic3 (
    mbno double precision,
    name varchar(255),
    pfno double precision,
    wingno double precision,
    officeno double precision,
    share double precision,
    rd double precision,
    prev_lt double precision,
    lt double precision,
    field10 double precision,
    field11 double precision,
    prev_st double precision,
    st double precision,
    field14 double precision,
    field15 double precision
);



CREATE TABLE "Sheet1$Print_Area" (
    "SR" double precision,
    "NAME OF MEMBERS" varchar(255),
    "FOLIO" double precision,
    "SHARE " double precision,
    "R#D#" varchar(255),
    "PREV LT" double precision,
    "LT" double precision,
    "LT1" double precision,
    "LT2" double precision,
    "PREV ST" double precision,
    "ST" double precision,
    "ST1" double precision,
    "ST2" double precision
);



CREATE TABLE results (
    "NAME OF MEMBERS" varchar(255),
    "SR" double precision,
    "FOLIO" double precision
);




CREATE TABLE bank_cheq_master (
    mbno              varchar(10)   NOT NULL,
    receipt_vchr_no   varchar(6)    NOT NULL,
    code              varchar(5)    NOT NULL,
    cheqno            varchar(10)   NOT NULL,
    cheqamt           numeric(18,2) NOT NULL DEFAULT 0,
    dates             timestamp     NOT NULL,
    reconcile_flag    varchar(1)    NOT NULL DEFAULT 'N',

    PRIMARY KEY (mbno, receipt_vchr_no, code)
);






