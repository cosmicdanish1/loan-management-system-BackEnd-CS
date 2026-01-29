-- Database Schema Export
-- Generated: 24/12/2025, 12:54:26 am
-- Database: EMP_Espat_Society

-- Table: acccess_recovery (10 rows)
CREATE TABLE IF NOT EXISTS "acccess_recovery" (
  "mbno" numeric,
  "acc_type" varchar(4),
  "short_amount" money NOT NULL,
  "short_interest_amount" money NOT NULL
);


-- Table: accountbalance (137 rows)
CREATE TABLE IF NOT EXISTS "accountbalance" (
  "acno" varchar(5),
  "acname" varchar(50),
  "groupledger" varchar(1),
  "parent" varchar(5),
  "printorder" varchar(15),
  "maincode" int4,
  "tropbal" numeric,
  "dbamt" numeric,
  "cramt" numeric,
  "clbal" numeric,
  "dbbal" numeric,
  "crbal" numeric
);


-- Table: akola_national (10 rows)
CREATE TABLE IF NOT EXISTS "akola_national" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" varchar(255),
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: akola_united (10 rows)
CREATE TABLE IF NOT EXISTS "akola_united" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" varchar(255),
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: amravati_united (10 rows)
CREATE TABLE IF NOT EXISTS "amravati_united" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: annualstatement (10 rows)
CREATE TABLE IF NOT EXISTS "annualstatement" (
  "accno" numeric,
  "op_triftamt" numeric,
  "cur_triftamt" numeric,
  "cur_tfintrec" numeric,
  "op_tfintrec" numeric,
  "op_shareamt" numeric,
  "cur_shareamt" numeric,
  "op_wfamt" numeric,
  "cur_wfamt" numeric,
  "rlbalance" numeric,
  "tlbalance" numeric
);


-- Table: aurangabad_unitd (10 rows)
CREATE TABLE IF NOT EXISTS "aurangabad_unitd" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" varchar(255),
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: balancesheet (143 rows)
CREATE TABLE IF NOT EXISTS "balancesheet" (
  "head_code" varchar(5),
  "parent_code" varchar(5),
  "head_name" varchar(75),
  "opening_balance" money NOT NULL,
  "debit" money NOT NULL,
  "credit" money NOT NULL,
  "closingbalance" money NOT NULL,
  "closingbal_db" money NOT NULL,
  "closing_cr" money NOT NULL,
  "maincd" int2
);


-- Table: balsheet (10 rows)
CREATE TABLE IF NOT EXISTS "balsheet" (
  "head_code" varchar(5),
  "parent_code" varchar(5),
  "head_name" varchar(75),
  "opening_balance" money NOT NULL,
  "debit" money NOT NULL,
  "credit" money NOT NULL,
  "closingbalance" money NOT NULL,
  "closingbal_db" money NOT NULL,
  "closing_cr" money NOT NULL,
  "maincd" int2
);


-- Table: bank_cheq_master (13286 rows)
CREATE TABLE IF NOT EXISTS "bank_cheq_master" (
  "mbno" varchar(10),
  "receipt_vchr_no" varchar(6),
  "code" varchar(5),
  "cheqno" varchar(10),
  "cheqamt" money NOT NULL,
  "dates" timestamp NOT NULL,
  "reconcile_flag" varchar(1)
);


-- Table: bank_passbook (1533 rows)
CREATE TABLE IF NOT EXISTS "bank_passbook" (
  "account_number" varchar(14),
  "tr_date" timestamp NOT NULL,
  "ledgerid" numeric,
  "lastlineno" numeric,
  "row_id" int4,
  "accounttype" varchar(20),
  "printedon" timestamp
);


-- Table: bank_passbook_bank_setting (2 rows)
CREATE TABLE IF NOT EXISTS "bank_passbook_bank_setting" (
  "passbook_bank_mst_id" numeric,
  "format_name" varchar(60),
  "ac_type" varchar(2)
);


-- Table: bank_passbook_detail_page (19 rows)
CREATE TABLE IF NOT EXISTS "bank_passbook_detail_page" (
  "passbook_detail_page_det_id" numeric,
  "passbook_bank_mst_id" numeric,
  "field_name" varchar(60),
  "field_row" numeric,
  "field_col" numeric,
  "visible_invisible_flag" varchar(1),
  "field_label" varchar(20)
);


-- Table: bank_passbook_first_page (8 rows)
CREATE TABLE IF NOT EXISTS "bank_passbook_first_page" (
  "passbook_first_page_det_id" numeric,
  "passbook_bank_mst_id" numeric,
  "display_name" varchar(60),
  "display_field_row" numeric,
  "display_field_col" numeric,
  "field_name" varchar(60),
  "field_row" numeric,
  "field_col" numeric,
  "print_display_name_flag" varchar(1),
  "visible_invisible_flag" varchar(1)
);


-- Table: bank_passbook_full (10 rows)
CREATE TABLE IF NOT EXISTS "bank_passbook_full" (
  "account_number" varchar(14),
  "tr_date" timestamp NOT NULL,
  "ledgerid" numeric,
  "lastlineno" numeric,
  "row_id" int4,
  "accounttype" varchar(20)
);


-- Table: bank_passbook_page_setting (2 rows)
CREATE TABLE IF NOT EXISTS "bank_passbook_page_setting" (
  "passbook_page_setting_det_id" numeric,
  "passbook_bank_mst_id" numeric,
  "total_pages" numeric,
  "total_rows" numeric,
  "start_line_number" numeric,
  "increment_level" numeric
);


-- Table: bank_passbooksetting (10 rows)
CREATE TABLE IF NOT EXISTS "bank_passbooksetting" (
  "passbooksettingid" int4 NOT NULL,
  "mbno" numeric,
  "passbooktype" varchar(20),
  "lastprintingdate" timestamp,
  "lastledgerid" numeric
);


-- Table: bank_saving_detail_product (10 rows)
CREATE TABLE IF NOT EXISTS "bank_saving_detail_product" (
  "account_number" varchar(14),
  "product_date" timestamp,
  "product" numeric,
  "total_product" numeric,
  "intt_rate" numeric
);


-- Table: bank_saving_product (5 rows)
CREATE TABLE IF NOT EXISTS "bank_saving_product" (
  "account_number" bpchar(14),
  "from_date" timestamp,
  "to_date" timestamp,
  "product" numeric,
  "posted" bpchar(1),
  "post_int" bpchar(1),
  "intramt" numeric,
  "rateofintr" numeric
);


-- Table: bank_sbintcalverify (10 rows)
CREATE TABLE IF NOT EXISTS "bank_sbintcalverify" (
  "account_number" bpchar(14),
  "fromdate" timestamp,
  "todate" timestamp,
  "accode" bpchar(4),
  "caldate" timestamp,
  "remarks" varchar(40),
  "source" bpchar(1),
  "intamt" numeric
);


-- Table: bank_signature (55 rows)
CREATE TABLE IF NOT EXISTS "bank_signature" (
  "account_number" varchar(14),
  "signature" bytea
);


-- Table: bankmas (10 rows)
CREATE TABLE IF NOT EXISTS "bankmas" (
  "gmst_code" float8,
  "nam_cap" varchar(255),
  "name" varchar(255),
  "addr1" varchar(255),
  "addr2" varchar(255),
  "city" varchar(255),
  "signfl" varchar(255),
  "mname" varchar(255),
  "maddr1" varchar(255),
  "maddr2" varchar(255),
  "mcity" varchar(255),
  "log_no" float8,
  "sign_ok" varchar(255),
  "POSITION" varchar(255),
  "mnam_cap" varchar(255),
  "occupation" varchar(255),
  "tele" varchar(255),
  "dept_code" varchar(255),
  "dtofbirth" varchar(255),
  "gender" varchar(255),
  "join_dt" varchar(255),
  "PASSWORD" varchar(255),
  "photofl" varchar(255),
  "photo_ok" varchar(255),
  "reg_code" float8,
  "soci_code" varchar(255),
  "emailadd" varchar(255),
  "emp_no" varchar(255),
  "gpfno" varchar(255),
  "mobilno" varchar(255),
  "desg_code" varchar(255),
  "firstdmdt" timestamp,
  "oldname" varchar(255),
  "bld_grp" varchar(255),
  "pan" varchar(255)
);


-- Table: bankopbal (130 rows)
CREATE TABLE IF NOT EXISTS "bankopbal" (
  "trfid" int4 NOT NULL,
  "fycode" int4,
  "headcode" varchar(5),
  "parentcode" varchar(5),
  "closingbalance" money
);


-- Table: busrules (4023 rows)
CREATE TABLE IF NOT EXISTS "busrules" (
  "srno" numeric,
  "appdate" timestamp NOT NULL,
  "rlnmaxloanamt" numeric,
  "rlnrate" numeric,
  "rlnpenalrate" numeric,
  "rlnmaxnoinst" numeric,
  "rlnnogr" numeric,
  "elnmaxloanamt" numeric,
  "elnrate" numeric,
  "elnmaxnoinst" numeric,
  "elnnogr" numeric,
  "alnmaxloanamt" numeric,
  "alnrate" numeric,
  "alnmaxnoinst" numeric,
  "alnnogr" numeric,
  "mlnmaxloanamt" numeric,
  "mlnrate" numeric,
  "mlnmaxnoinst" numeric,
  "mlnnogr" numeric,
  "minmembship" numeric,
  "workexp" varchar(10),
  "sharerecov" varchar(20),
  "defaultduration" int4 NOT NULL,
  "minshareamt" numeric,
  "maxshareamt" numeric,
  "minmdamt" numeric,
  "mincdamt" numeric,
  "maxcdamt" numeric,
  "edlmaxloanamt" numeric,
  "edlrate" numeric,
  "edlpenalrate" numeric,
  "edlmaxnoinst" numeric,
  "edlnogr" numeric,
  "dataentryflag" varchar(1),
  "print_demand_horizontal" varchar(1),
  "emi_based_demand" varchar(1),
  "minsavingbalance" numeric,
  "working_exp_code" varchar(5),
  "reducingbal_intt_calc" varchar(1),
  "intt_slot" int2,
  "flnmaxloanamt" numeric,
  "flnmaxnoinst" numeric,
  "flnnogr" numeric,
  "flnpenalrate" numeric,
  "flnrate" numeric,
  "slnmaxloanamt" numeric,
  "slnrate" numeric,
  "slnmaxnoinst" numeric,
  "slnnogr" numeric,
  "loanmaxlimit" numeric,
  "loanagainstbasic" numeric,
  "loanagainstdeppercent" numeric,
  "consolidateinttamountindemand" varchar(1),
  "considerintt" varchar(1),
  "exporttoexcel" varchar(1),
  "visibleflag" varchar(1),
  "profit_head_code" varchar(5)
);


-- Table: castcategorymaster (4 rows)
CREATE TABLE IF NOT EXISTS "castcategorymaster" (
  "id" int4 NOT NULL,
  "castcategory" varchar(30)
);


-- Table: codes_table (4 rows)
CREATE TABLE IF NOT EXISTS "codes_table" (
  "rpt_name" varchar(10),
  "grp_name" varchar(10),
  "codes_used" varchar(50),
  "description" varchar(100)
);


-- Table: convertmember (10 rows)
CREATE TABLE IF NOT EXISTS "convertmember" (
  "accno" numeric,
  "prefix" varchar(5),
  "f_name" varchar(50),
  "m_name" varchar(20),
  "l_name" varchar(20)
);


-- Table: crplhor (41 rows)
CREATE TABLE IF NOT EXISTS "crplhor" (
  "tblid" int4 NOT NULL,
  "expenditure" varchar(150),
  "examt" numeric,
  "extotal" numeric
);


-- Table: crplhor1 (41 rows)
CREATE TABLE IF NOT EXISTS "crplhor1" (
  "tblid" int4 NOT NULL,
  "income" varchar(150),
  "incamt" numeric,
  "inctotal" numeric
);


-- Table: crybsnew (105 rows)
CREATE TABLE IF NOT EXISTS "crybsnew" (
  "ason" numeric,
  "asonbal" numeric,
  "particulars" varchar(200),
  "amount" numeric,
  "total" numeric
);


-- Table: crypl (10 rows)
CREATE TABLE IF NOT EXISTS "crypl" (
  "acname" varchar(200),
  "balance" numeric,
  "lyrbl" numeric,
  "llyrbl" numeric,
  "total" numeric,
  "crdr" varchar(10)
);


-- Table: crytb (10 rows)
CREATE TABLE IF NOT EXISTS "crytb" (
  "rownum" int4 NOT NULL,
  "levelnum" varchar(15),
  "headname" varchar(250),
  "opbal" numeric,
  "curdb" numeric,
  "curcr" numeric,
  "prgdb" numeric,
  "prgcr" numeric,
  "cldb" numeric,
  "clcr" numeric,
  "headcode" varchar(20),
  "space" varchar(10)
);


-- Table: daily_gl_history (16348 rows)
CREATE TABLE IF NOT EXISTS "daily_gl_history" (
  "trans_date" timestamp NOT NULL,
  "code" varchar(6),
  "balance" money NOT NULL
);


-- Table: day_end_processes (10 rows)
CREATE TABLE IF NOT EXISTS "day_end_processes" (
  "id" int4 NOT NULL,
  "processDate" timestamp,
  "status" varchar(20),
  "startedAt" timestamp,
  "completedAt" timestamp,
  "failedAt" timestamp,
  "errorMessage" text,
  "processResults" json,
  "processSteps" json,
  "initiatedBy" int4,
  "createdAt" timestamp,
  "updatedAt" timestamp
);

ALTER TABLE "day_end_processes" ADD CONSTRAINT "day_end_processes_pkey" PRIMARY KEY ("id");

-- Table: demand_master (227527 rows)
CREATE TABLE IF NOT EXISTS "demand_master" (
  "demand_for_year" int4 NOT NULL,
  "demand_for_month" int4 NOT NULL,
  "mbno" numeric,
  "demand_posted" varchar(1),
  "rln_amount" numeric,
  "eln_amount" numeric,
  "aln_amount" numeric,
  "mln_amount" numeric,
  "rln_installment_amount" numeric,
  "rln_interest" numeric,
  "eln_installment_amount" numeric,
  "eln_interest" numeric,
  "aln_installment_amount" numeric,
  "aln_interest" numeric,
  "mln_installment_amount" numeric,
  "mln_interest" numeric,
  "rd_amount" numeric,
  "md_amount" numeric,
  "cd_amount" numeric,
  "shr_amount" numeric,
  "bankcharge" numeric,
  "sd" varchar(1),
  "balance_for_month" numeric,
  "dmnd_gnrt_date" timestamp,
  "officeno" int4 NOT NULL,
  "totaldemand" numeric,
  "OTHERS" numeric,
  "rdbalance" numeric,
  "mdbalance" numeric,
  "cdbalance" numeric,
  "shrbalance" numeric,
  "receipt_vchr_no" varchar(6),
  "dmnd_post_date" timestamp,
  "passflag" varchar(1),
  "dmnd_srno" int4 NOT NULL,
  "edl_amount" numeric,
  "edl_installment_amount" numeric,
  "edl_interest" numeric,
  "loancaseno" int4,
  "fln_amount" money,
  "fln_installment_amount" money,
  "fln_interest" money,
  "fromdate" timestamp,
  "uptodate" timestamp,
  "md1_amount" numeric,
  "md2_amount" numeric,
  "md3_amount" numeric,
  "md4_amount" numeric,
  "md5_amount" numeric,
  "md1balance" numeric,
  "md2balance" numeric,
  "md3balance" numeric,
  "md4balance" numeric,
  "md5balance" numeric
);


-- Table: demand_masterdelete (399795 rows)
CREATE TABLE IF NOT EXISTS "demand_masterdelete" (
  "demand_for_year" int4 NOT NULL,
  "demand_for_month" int4 NOT NULL,
  "mbno" numeric,
  "demand_posted" varchar(1),
  "rln_amount" numeric,
  "eln_amount" numeric,
  "aln_amount" numeric,
  "mln_amount" numeric,
  "rln_installment_amount" numeric,
  "rln_interest" numeric,
  "eln_installment_amount" numeric,
  "eln_interest" numeric,
  "aln_installment_amount" numeric,
  "aln_interest" numeric,
  "mln_installment_amount" numeric,
  "mln_interest" numeric,
  "rd_amount" numeric,
  "md_amount" numeric,
  "cd_amount" numeric,
  "shr_amount" numeric,
  "bankcharge" numeric,
  "sd" varchar(1),
  "balance_for_month" numeric,
  "dmnd_gnrt_date" timestamp,
  "officeno" int4 NOT NULL,
  "totaldemand" numeric,
  "OTHERS" numeric,
  "rdbalance" numeric,
  "mdbalance" numeric,
  "cdbalance" numeric,
  "shrbalance" numeric,
  "receipt_vchr_no" varchar(6),
  "dmnd_post_date" timestamp,
  "passflag" varchar(1),
  "dmnd_srno" int4 NOT NULL,
  "deletedon" timestamp,
  "edl_amount" numeric,
  "edl_installment_amount" numeric,
  "edl_interest" numeric
);


-- Table: demand_oth_head (9 rows)
CREATE TABLE IF NOT EXISTS "demand_oth_head" (
  "head_code" varchar(5),
  "description" varchar(50)
);


-- Table: demand_receipt (10 rows)
CREATE TABLE IF NOT EXISTS "demand_receipt" (
  "trans_no" int4 NOT NULL,
  "trans_date" timestamp NOT NULL,
  "mbno" numeric,
  "dyear" int4 NOT NULL,
  "dmonth" int4 NOT NULL,
  "code" varchar(5),
  "trans_type" varchar(2),
  "acc_no" int4 NOT NULL,
  "acc_type" varchar(4),
  "trans_amt" money NOT NULL,
  "receipt_vchr_no" varchar(6),
  "vchr_type" varchar(2),
  "modeofpay" varchar(2),
  "cheq_no" varchar(10),
  "cheq_amt" money NOT NULL,
  "cheq_date" timestamp,
  "bankname" varchar(75),
  "pass_flag" varchar(1),
  "cashier_flag" varchar(1),
  "narration" varchar(100),
  "username" varchar(50)
);


-- Table: demandbyhand (10 rows)
CREATE TABLE IF NOT EXISTS "demandbyhand" (
  "demand_for_year" int4 NOT NULL,
  "demand_for_month" int4 NOT NULL,
  "mbno" numeric,
  "demand_posted" varchar(1),
  "rln_amount" money NOT NULL,
  "tln_amount" money NOT NULL,
  "rln_installment_amount" money NOT NULL,
  "rln_interest" money NOT NULL,
  "tln_installment_amount" money NOT NULL,
  "tln_interest" money NOT NULL,
  "tf_amount" money NOT NULL,
  "wf_amount" money NOT NULL,
  "shr_amount" money NOT NULL,
  "sd" varchar(1),
  "balance_for_month" money NOT NULL,
  "dmnd_gnrt_date" timestamp,
  "officeno" int4 NOT NULL,
  "totaldemand" money NOT NULL,
  "OTHERS" money NOT NULL,
  "receipt_vchr_no" varchar(6),
  "dmnd_post_date" timestamp,
  "passflag" varchar(1),
  "dmnd_srno" int4 NOT NULL,
  "username" varchar(50)
);


-- Table: demandbyhanddeleted (10 rows)
CREATE TABLE IF NOT EXISTS "demandbyhanddeleted" (
  "demand_for_year" int4 NOT NULL,
  "demand_for_month" int4 NOT NULL,
  "mbno" numeric,
  "demand_posted" varchar(1),
  "rln_amount" money NOT NULL,
  "tln_amount" money NOT NULL,
  "rln_installment_amount" money NOT NULL,
  "rln_interest" money NOT NULL,
  "tln_installment_amount" money NOT NULL,
  "tln_interest" money NOT NULL,
  "tf_amount" money NOT NULL,
  "wf_amount" money NOT NULL,
  "shr_amount" money NOT NULL,
  "sd" varchar(1),
  "balance_for_month" money NOT NULL,
  "dmnd_gnrt_date" timestamp,
  "officeno" int4 NOT NULL,
  "totaldemand" money NOT NULL,
  "OTHERS" money NOT NULL,
  "receipt_vchr_no" varchar(6),
  "dmnd_post_date" timestamp,
  "passflag" varchar(1),
  "dmnd_srno" int4 NOT NULL,
  "username" varchar(50),
  "narration" varchar(100),
  "deletedon" timestamp
);


-- Table: demandprintorder (6 rows)
CREATE TABLE IF NOT EXISTS "demandprintorder" (
  "row_id" numeric,
  "code" varchar(6),
  "headtype" varchar(4),
  "interest" varchar(4),
  "description" varchar(20),
  "map_demand_columnname" varchar(40),
  "printorder" int4
);


-- Table: deposit_slabs (10 rows)
CREATE TABLE IF NOT EXISTS "deposit_slabs" (
  "id" int4 NOT NULL,
  "name" varchar(100),
  "description" text,
  "type" varchar(50),
  "minAmount" numeric,
  "maxAmount" numeric,
  "minTenure" int4,
  "maxTenure" int4,
  "interestRate" numeric,
  "penaltyRate" numeric,
  "isActive" bool,
  "effectiveFrom" timestamp,
  "effectiveTo" timestamp,
  "createdAt" timestamp,
  "updatedAt" timestamp
);

ALTER TABLE "deposit_slabs" ADD CONSTRAINT "deposit_slabs_pkey" PRIMARY KEY ("id");

-- Table: designation_master (10 rows)
CREATE TABLE IF NOT EXISTS "designation_master" (
  "designationcode" varchar(20),
  "designationname" varchar(100),
  "designationlevel" int4
);


-- Table: division_master (6 rows)
CREATE TABLE IF NOT EXISTS "division_master" (
  "wingno" varchar(6),
  "officeno" int4 NOT NULL,
  "divno" int4 NOT NULL,
  "name" varchar(200),
  "address" varchar(200),
  "city" varchar(20)
);


-- Table: doi_national (10 rows)
CREATE TABLE IF NOT EXISTS "doi_national" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: doi_united (10 rows)
CREATE TABLE IF NOT EXISTS "doi_united" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: doii_national (10 rows)
CREATE TABLE IF NOT EXISTS "doii_national" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: doii_united (10 rows)
CREATE TABLE IF NOT EXISTS "doii_united" (
  "mbno" float8,
  "name" varchar(255),
  "folio" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: doiii_national (10 rows)
CREATE TABLE IF NOT EXISTS "doiii_national" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: doiv_national (10 rows)
CREATE TABLE IF NOT EXISTS "doiv_national" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: dov_national (10 rows)
CREATE TABLE IF NOT EXISTS "dov_national" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: dt_master (7243 rows)
CREATE TABLE IF NOT EXISTS "dt_master" (
  "Sr#No" float8,
  "ms_no" varchar(9),
  "p_no" float8,
  "share_opbal" float8,
  "sharecr" varchar(255),
  "sharedr" float8,
  "share_bal" float8,
  "fd_opbal" float8,
  "fdcr" float8,
  "fddr" float8,
  "fd_bal" float8,
  "loan_opbal" float8,
  "loandr" varchar(255),
  "Total_Op+Dr" float8,
  "loancr" float8,
  "loanbal" float8,
  "officename" varchar(255),
  "f18" varchar(255),
  "f19" varchar(255)
);


-- Table: dt_member (7249 rows)
CREATE TABLE IF NOT EXISTS "dt_member" (
  "Sr#No" float8,
  "ms_no" varchar(15),
  "p_no" float8,
  "share_opbal" float8,
  "sharecr" varchar(255),
  "sharedr" float8,
  "share_bal" float8,
  "fd_opbal" float8,
  "fdcr" float8,
  "fddr" float8,
  "fd_bal" float8,
  "loan_opbal" float8,
  "loandr" varchar(255),
  "Total_Op+Dr" float8,
  "loancr" float8,
  "loanbal" float8,
  "officename" varchar(255),
  "f18" varchar(255),
  "f19" varchar(255)
);


-- Table: dtproperties (10 rows)
CREATE TABLE IF NOT EXISTS "dtproperties" (
  "id" int4 NOT NULL,
  "objectid" int4,
  "property" varchar(64),
  "value" varchar(255),
  "lvalue" bytea,
  "version" int4 NOT NULL,
  "uvalue" varchar(255)
);


-- Table: fd_interest_master (5 rows)
CREATE TABLE IF NOT EXISTS "fd_interest_master" (
  "id" numeric,
  "interest_mst_id" numeric,
  "mbno" numeric,
  "account_number" numeric,
  "amount" numeric,
  "rate" numeric,
  "post" varchar(1),
  "posted" varchar(1),
  "calc_from_date" timestamp,
  "calc_to_date" timestamp,
  "to_date" timestamp,
  "from_date" timestamp,
  "remarks" varchar(50),
  "postdate" timestamp,
  "vchrno" varchar(6),
  "fdamount" numeric
);


-- Table: fdmaster (10 rows)
CREATE TABLE IF NOT EXISTS "fdmaster" (
  "mbno" numeric,
  "account_number" numeric,
  "prefix" varchar(5),
  "f_name" varchar(50),
  "m_name" varchar(50),
  "l_name" varchar(50),
  "certno" varchar(10),
  "depunit" int4,
  "depperiod" numeric,
  "rate" numeric,
  "depdate" timestamp,
  "matdate" timestamp,
  "fdamount" numeric,
  "matamount" numeric,
  "interestbalance" numeric,
  "interestpayamentmode" int4 NOT NULL,
  "interestamount" numeric,
  "lastintpaydate" timestamp,
  "intpaid" numeric,
  "status" varchar(1),
  "statusdate" timestamp,
  "nominee" varchar(80),
  "nage" varchar(6),
  "naddr" varchar(100),
  "nrelation" varchar(25),
  "fdrdflag" varchar(1),
  "remarks" varchar(100),
  "openbal" numeric,
  "rd_by_demand" varchar(1),
  "operationmode" numeric,
  "intcalmethod" int4,
  "refmbno" int4,
  "headcode" varchar(5),
  "oldacno" int4,
  "jointdetails" varchar(400)
);


-- Table: fdmasterhistory (10 rows)
CREATE TABLE IF NOT EXISTS "fdmasterhistory" (
  "mbno" numeric,
  "account_number" numeric,
  "prefix" varchar(5),
  "f_name" varchar(50),
  "m_name" varchar(50),
  "l_name" varchar(50),
  "certno" varchar(10),
  "depunit" int4 NOT NULL,
  "depperiod" numeric,
  "rate" numeric,
  "depdate" timestamp NOT NULL,
  "matdate" timestamp,
  "fdamount" numeric,
  "matamount" numeric,
  "interestbalance" numeric,
  "interestpayamentmode" int4 NOT NULL,
  "interestamount" numeric,
  "lastintpaydate" timestamp,
  "intpaid" numeric,
  "status" varchar(1),
  "statusdate" timestamp,
  "nominee" varchar(80),
  "nage" varchar(6),
  "naddr" varchar(100),
  "nrelation" varchar(25),
  "fdrdflag" varchar(1),
  "remarks" varchar(100),
  "openbal" numeric,
  "modifieddate" timestamp
);


-- Table: fdrd_balance (10 rows)
CREATE TABLE IF NOT EXISTS "fdrd_balance" (
  "mbno" numeric,
  "fdrdflag" varchar(2),
  "acc_status" varchar(6),
  "account_number" numeric,
  "openbal" numeric,
  "credit" money,
  "debit" money,
  "balance" numeric
);


-- Table: fdrd_slab_details (15 rows)
CREATE TABLE IF NOT EXISTS "fdrd_slab_details" (
  "id" numeric,
  "fdrd" varchar(2),
  "scheme_code" varchar(4),
  "from_amount" numeric,
  "upto_amount" numeric,
  "from_period" numeric,
  "upto_period" numeric,
  "period_unit" varchar(2),
  "interest_rate" numeric,
  "premature_interest_rate" numeric,
  "applicable_from_date" timestamp,
  "applicable_upto_date" timestamp
);


-- Table: fdrdlienmaster (10 rows)
CREATE TABLE IF NOT EXISTS "fdrdlienmaster" (
  "srno" numeric,
  "loancaseno" numeric,
  "mbno" numeric,
  "fdrd_accountnumber" numeric,
  "fromdate" timestamp,
  "username" varchar(30)
);


-- Table: fdrdlienmaster_history (10 rows)
CREATE TABLE IF NOT EXISTS "fdrdlienmaster_history" (
  "loancaseno" numeric,
  "mbno" numeric,
  "fdrd_accountnumber" numeric,
  "fromdate" timestamp NOT NULL,
  "todate" timestamp NOT NULL,
  "lienby" varchar(50),
  "removeby" varchar(50)
);


-- Table: fixed_deposits (10 rows)
CREATE TABLE IF NOT EXISTS "fixed_deposits" (
  "id" int4 NOT NULL,
  "accountNumber" varchar(20) NOT NULL,
  "memberId" int4 NOT NULL,
  "principalAmount" numeric NOT NULL,
  "interestRate" numeric NOT NULL,
  "depositDate" date NOT NULL,
  "maturityDate" date NOT NULL,
  "tenureMonths" int4 NOT NULL,
  "maturityAmount" numeric NOT NULL,
  "interestAccrued" numeric NOT NULL,
  "status" varchar NOT NULL,
  "closureDate" date,
  "closureAmount" numeric,
  "penaltyAmount" numeric,
  "closureReason" text,
  "isAutoRenewal" bool NOT NULL,
  "lastInterestCalculationDate" date,
  "createdAt" timestamp NOT NULL,
  "updatedAt" timestamp NOT NULL,
  "deletedAt" timestamp
);


-- Table: frs (6454 rows)
CREATE TABLE IF NOT EXISTS "frs" (
  "sr_no" numeric,
  "mbno" numeric,
  "pfno" numeric,
  "mbname" varchar(50),
  "frs" money NOT NULL,
  "frs_fund" money NOT NULL
);


-- Table: frs_balance (6735 rows)
CREATE TABLE IF NOT EXISTS "frs_balance" (
  "mbno" numeric,
  "balance" money
);


-- Table: fundsmaster (7015 rows)
CREATE TABLE IF NOT EXISTS "fundsmaster" (
  "mbno" numeric,
  "mdamt" numeric,
  "cdamt" numeric,
  "shareamt" numeric,
  "mdopbal" numeric,
  "shareopbal" numeric,
  "cdopbal" numeric,
  "lnexecrec" money,
  "suspbal" money,
  "md1_amount" money,
  "md2_amount" money,
  "md3_amount" money,
  "md4_amount" money,
  "md5_amount" money,
  "md1_opbal" money,
  "md2_opbal" money,
  "md3_opbal" money,
  "md4_opbal" money,
  "md5_opbal" money
);


-- Table: getworkingdate (1455 rows)
CREATE TABLE IF NOT EXISTS "getworkingdate" (
  "working_date" timestamp NOT NULL,
  "payment_voucher" int2 NOT NULL,
  "receipt_voucher" int2 NOT NULL,
  "journal_voucher" int2 NOT NULL,
  "dayend_flag" varchar(1),
  "updategl_flag" varchar(1)
);


-- Table: guarrenter_mast (5 rows)
CREATE TABLE IF NOT EXISTS "guarrenter_mast" (
  "guarrenter_mbno" varchar(10),
  "balance" money,
  "openbalance" money
);


-- Table: headmaster (168 rows)
CREATE TABLE IF NOT EXISTS "headmaster" (
  "code" varchar(5),
  "parent_code" varchar(5),
  "hposition" varchar(12),
  "head_name" varchar(100),
  "interest" varchar(4),
  "headtype" varchar(4),
  "op_bal" money,
  "pflag" varchar(4)
);


-- Table: headtype (20 rows)
CREATE TABLE IF NOT EXISTS "headtype" (
  "headtype" varchar(4),
  "ldtype" varchar(1),
  "remark" varchar(30),
  "woking_charges_flag" varchar(1),
  "active_head_flag" varchar(1)
);


-- Table: interest_postings (10 rows)
CREATE TABLE IF NOT EXISTS "interest_postings" (
  "id" int4 NOT NULL,
  "memberId" int4,
  "accountId" int4,
  "accountNumber" varchar(20),
  "type" varchar(20),
  "principalAmount" numeric,
  "interestRate" numeric,
  "interestAmount" numeric,
  "calculationDate" timestamp,
  "postingDate" timestamp,
  "status" varchar(20),
  "transactionId" int4,
  "remarks" text,
  "createdAt" timestamp
);

ALTER TABLE "interest_postings" ADD CONSTRAINT "interest_postings_pkey" PRIMARY KEY ("id");

-- Table: interest_rates (10 rows)
CREATE TABLE IF NOT EXISTS "interest_rates" (
  "id" int4 NOT NULL,
  "name" varchar(100),
  "description" text,
  "type" varchar(50),
  "rate" numeric,
  "calculationMethod" varchar(50),
  "minAmount" numeric,
  "maxAmount" numeric,
  "minTenure" int4,
  "maxTenure" int4,
  "isActive" bool,
  "effectiveFrom" timestamp,
  "effectiveTo" timestamp,
  "createdAt" timestamp,
  "updatedAt" timestamp
);

ALTER TABLE "interest_rates" ADD CONSTRAINT "interest_rates_pkey" PRIMARY KEY ("id");

-- Table: interestmaster (10 rows)
CREATE TABLE IF NOT EXISTS "interestmaster" (
  "id" numeric,
  "inttype" varchar(3),
  "frdt" timestamp,
  "todt" timestamp,
  "rate" money NOT NULL
);


-- Table: interestpaid (10 rows)
CREATE TABLE IF NOT EXISTS "interestpaid" (
  "id" numeric,
  "mbno" numeric,
  "wrno" varchar(20),
  "opbal" numeric,
  "totdr" numeric,
  "totcr" numeric,
  "closebal" numeric,
  "amount" money NOT NULL,
  "interest" money NOT NULL,
  "post" varchar(1),
  "paid" varchar(1),
  "paydate" timestamp,
  "vchrno" varchar(6),
  "account_number" numeric,
  "rowid" int4 NOT NULL
);


-- Table: jalgaon_united (10 rows)
CREATE TABLE IF NOT EXISTS "jalgaon_united" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: jointmaster (10 rows)
CREATE TABLE IF NOT EXISTS "jointmaster" (
  "joint_id" int8 NOT NULL,
  "mbno" int8 NOT NULL,
  "account_number" int8 NOT NULL,
  "name" varchar(50) NOT NULL,
  "address" varchar(75)
);


-- Table: led (10 rows)
CREATE TABLE IF NOT EXISTS "led" (
  "trans_no" numeric,
  "trans_date" timestamp NOT NULL,
  "trans_type" varchar(2),
  "code" varchar(5),
  "mbno" numeric,
  "acc_no" numeric,
  "acc_type" varchar(4),
  "trans_amt" money NOT NULL,
  "receipt_vchr_no" varchar(6),
  "vchr_type" varchar(2),
  "modeofpay" varchar(1),
  "pl_balance" money NOT NULL,
  "narration" varchar(500),
  "username" varchar(50),
  "cust_bank_name" varchar(100)
);


-- Table: ledger (1284476 rows)
CREATE TABLE IF NOT EXISTS "ledger" (
  "trans_no" numeric,
  "trans_date" timestamp NOT NULL,
  "trans_type" varchar(2),
  "code" varchar(5),
  "mbno" numeric,
  "acc_no" numeric,
  "acc_type" varchar(4),
  "trans_amt" money NOT NULL,
  "receipt_vchr_no" varchar(6),
  "vchr_type" varchar(2),
  "modeofpay" varchar(1),
  "pl_balance" money NOT NULL,
  "narration" varchar(500),
  "username" varchar(50),
  "cust_bank_name" varchar(100),
  "ledgerid" int4 NOT NULL
);


-- Table: ledger_data (4733 rows)
CREATE TABLE IF NOT EXISTS "ledger_data" (
  "mbno" numeric,
  "pfno" varchar(10),
  "name" varchar(200),
  "i1005_dr" money,
  "l1004_cr" money,
  "l1024_dr" money,
  "l1004cr" money,
  "l1004_dr" money,
  "l1003_cr" money
);


-- Table: loan_accounts (10 rows)
CREATE TABLE IF NOT EXISTS "loan_accounts" (
  "id" int4 NOT NULL,
  "accountNumber" varchar(20) NOT NULL,
  "memberId" int4 NOT NULL,
  "principalAmount" numeric NOT NULL,
  "interestRate" numeric NOT NULL,
  "outstandingBalance" numeric NOT NULL,
  "loanType" varchar(50) NOT NULL,
  "disbursementDate" date NOT NULL,
  "maturityDate" date NOT NULL,
  "tenureMonths" int4 NOT NULL,
  "emiAmount" numeric,
  "purpose" varchar(100),
  "suretyName" varchar(100),
  "suretyPhone" varchar(15),
  "suretyAddress" text,
  "status" varchar NOT NULL,
  "totalInterestAccrued" numeric NOT NULL,
  "totalPaid" numeric NOT NULL,
  "lastInterestCalculationDate" date,
  "closureDate" date,
  "createdAt" timestamp NOT NULL,
  "updatedAt" timestamp NOT NULL,
  "deletedAt" timestamp
);


-- Table: loan_balance_history (189007 rows)
CREATE TABLE IF NOT EXISTS "loan_balance_history" (
  "mbno" int4,
  "headtype" varchar(10),
  "opbal" money,
  "debit" money,
  "credit" money,
  "balance" money,
  "bal_date" timestamp,
  "intrate" money
);


-- Table: loan_interest_master (10 rows)
CREATE TABLE IF NOT EXISTS "loan_interest_master" (
  "mbno" int4,
  "accno" int4,
  "headtype" varchar(5),
  "headcode" varchar(5),
  "to_date" timestamp
);


-- Table: loan_limit_master (10 rows)
CREATE TABLE IF NOT EXISTS "loan_limit_master" (
  "loan_limit_id" numeric,
  "code" varchar(5)
);


-- Table: loan_master (29579 rows)
CREATE TABLE IF NOT EXISTS "loan_master" (
  "mbno" numeric,
  "loantype" varchar(3),
  "loancaseno" numeric,
  "loan_amt" money NOT NULL,
  "payment_date" timestamp NOT NULL,
  "rate" money NOT NULL,
  "no_of_instal" int2 NOT NULL,
  "instal_amt" money NOT NULL,
  "balance" money NOT NULL,
  "openbalance" money NOT NULL,
  "purpose" varchar(50),
  "intt_amount" numeric,
  "penalrate" numeric
);


-- Table: loan_masterhistory (9544 rows)
CREATE TABLE IF NOT EXISTS "loan_masterhistory" (
  "mbno" numeric,
  "loantype" varchar(3),
  "loancaseno" numeric,
  "loan_amt" money NOT NULL,
  "payment_date" timestamp NOT NULL,
  "rate" money NOT NULL,
  "no_of_instal" int2 NOT NULL,
  "instal_amt" money NOT NULL,
  "balance" money NOT NULL,
  "openbalance" money NOT NULL,
  "purpose" varchar(50),
  "rowid" numeric,
  "intt_amount" numeric,
  "penalrate" numeric
);


-- Table: loan_nominee (1 rows)
CREATE TABLE IF NOT EXISTS "loan_nominee" (
  "srno" numeric,
  "loancaseno" numeric,
  "name" varchar(50),
  "address" varchar(50),
  "age" int2,
  "relation" varchar(25)
);


-- Table: loan_opbal (10 rows)
CREATE TABLE IF NOT EXISTS "loan_opbal" (
  "mbno" numeric,
  "loancaseno" numeric,
  "openbalance" money NOT NULL,
  "loan_type" varchar(50),
  "headtype" varchar(4)
);


-- Table: loan_payments (10 rows)
CREATE TABLE IF NOT EXISTS "loan_payments" (
  "id" int4 NOT NULL,
  "paymentNumber" varchar(20) NOT NULL,
  "loanAccountId" int4 NOT NULL,
  "amount" numeric NOT NULL,
  "principalAmount" numeric NOT NULL,
  "interestAmount" numeric NOT NULL,
  "penaltyAmount" numeric NOT NULL,
  "paymentDate" date NOT NULL,
  "paymentMethod" varchar(50) NOT NULL,
  "referenceNumber" varchar(50),
  "remarks" text,
  "receiptNumber" varchar(20),
  "status" varchar NOT NULL,
  "balanceAfterPayment" numeric NOT NULL,
  "createdAt" timestamp NOT NULL,
  "updatedAt" timestamp NOT NULL
);


-- Table: loan_pending (16035 rows)
CREATE TABLE IF NOT EXISTS "loan_pending" (
  "loancaseno" numeric,
  "mbno" numeric,
  "loantype" varchar(3),
  "applied_amt" money NOT NULL,
  "sanctioned_amt" money NOT NULL,
  "app_date" timestamp,
  "sanctioned_date" timestamp,
  "no_of_instal" int2 NOT NULL,
  "g1mbno" numeric,
  "g2mbno" numeric,
  "g3mbno" numeric,
  "purpose" varchar(50),
  "flg_sanctioned" varchar(1),
  "flg_paid" varchar(1),
  "form_number" varchar(10)
);


-- Table: loan_pending_aln (156 rows)
CREATE TABLE IF NOT EXISTS "loan_pending_aln" (
  "loancaseno" numeric,
  "mbno" numeric,
  "loantype" varchar(3),
  "applied_amt" money NOT NULL,
  "sanctioned_amt" money NOT NULL,
  "app_date" timestamp,
  "sanctioned_date" timestamp,
  "no_of_instal" int2 NOT NULL,
  "g1mbno" numeric,
  "g2mbno" numeric,
  "g3mbno" numeric,
  "purpose" varchar(50),
  "flg_sanctioned" varchar(1),
  "flg_paid" varchar(1),
  "form_number" varchar(10)
);


-- Table: loan_pending_rln (105 rows)
CREATE TABLE IF NOT EXISTS "loan_pending_rln" (
  "loancaseno" numeric,
  "mbno" numeric,
  "loantype" varchar(3),
  "applied_amt" money NOT NULL,
  "sanctioned_amt" money NOT NULL,
  "app_date" timestamp,
  "sanctioned_date" timestamp,
  "no_of_instal" int2 NOT NULL,
  "g1mbno" numeric,
  "g2mbno" numeric,
  "g3mbno" numeric,
  "purpose" varchar(50),
  "flg_sanctioned" varchar(1),
  "flg_paid" varchar(1),
  "form_number" varchar(10)
);


-- Table: loan_product (10701 rows)
CREATE TABLE IF NOT EXISTS "loan_product" (
  "id" numeric,
  "mbno" numeric,
  "opbal" numeric,
  "totdr" numeric,
  "totcr" numeric,
  "closebal" numeric,
  "amount" money NOT NULL,
  "interest" money NOT NULL,
  "headtype" varchar(5)
);


-- Table: logintime (17061 rows)
CREATE TABLE IF NOT EXISTS "logintime" (
  "login_date" timestamp NOT NULL,
  "userid" int2 NOT NULL,
  "login_time" varchar(12),
  "logout_time" varchar(12)
);


-- Table: main (10 rows)
CREATE TABLE IF NOT EXISTS "main" (
  "maincode" int4 NOT NULL,
  "mainname" varchar(25),
  "bankheadcode" varchar(6)
);


-- Table: member_balances (6505 rows)
CREATE TABLE IF NOT EXISTS "member_balances" (
  "srno" float8,
  "mbno" float8,
  "pfno" float8,
  "member_name" varchar(255),
  "officeno" float8,
  "dr_cr" float8,
  "shares" float8,
  "int_rate" float8,
  "compulsory_deposit" float8,
  "rd_amt" float8,
  "dep_date" timestamp,
  "iscompound" float8,
  "loanint_rate" float8,
  "regularloan" float8,
  "regularinstallamt" float8,
  "int_amount" float8,
  "eloanint_rate" float8,
  "emergency_loan_balance" float8,
  "einstallamt" float8,
  "eint_amount" float8,
  "frsbalance" float8
);


-- Table: member_bookbal (134 rows)
CREATE TABLE IF NOT EXISTS "member_bookbal" (
  "mbno" numeric,
  "pfno" varchar(10),
  "f_name" varchar(50),
  "officeno" int4 NOT NULL,
  "frs_no" varchar(20)
);


-- Table: member_data (10 rows)
CREATE TABLE IF NOT EXISTS "member_data" (
  "mbno" numeric,
  "pfno" varchar(10),
  "f_name" varchar(50),
  "officeno" int4 NOT NULL,
  "frs_no" varchar(20)
);


-- Table: member_master (9782 rows)
CREATE TABLE IF NOT EXISTS "member_master" (
  "mbno" numeric,
  "prefix" varchar(10),
  "f_name" varchar(50),
  "m_name" varchar(50),
  "l_name" varchar(50),
  "sex" varchar(1),
  "desig" varchar(40),
  "present_address" varchar(200),
  "permanent_address" varchar(200),
  "wingno" varchar(6),
  "officeno" int4 NOT NULL,
  "age" varchar(2),
  "dob" timestamp,
  "date_of_appt" timestamp,
  "dor" timestamp,
  "permanetdate" timestamp,
  "quasiperdate" timestamp,
  "supanuationdate" timestamp,
  "gross_salary" numeric,
  "basic_pay" numeric,
  "nominee_name" varchar(40),
  "nominee_address" varchar(200),
  "nominee_relation" varchar(25),
  "declare_date" timestamp,
  "flg_retire" varchar(1),
  "memb_date" timestamp,
  "pfno" varchar(10),
  "lfno" varchar(10),
  "flg_incometax" varchar(2),
  "flg_insured" varchar(1),
  "insureamt" numeric,
  "remarks" varchar(100),
  "date_of_retirement" timestamp,
  "dept_name" varchar(50),
  "cbsac" varchar(20),
  "isactive" varchar(1),
  "aadharno" varchar(20),
  "phoneno" varchar(20),
  "pan_no" varchar(20),
  "frs_no" varchar(20),
  "fathers_name" varchar(100),
  "branchmsno" varchar(20)
);


-- Table: member_masterdelete (10 rows)
CREATE TABLE IF NOT EXISTS "member_masterdelete" (
  "mbno" numeric,
  "prefix" varchar(5),
  "f_name" varchar(50),
  "m_name" varchar(20),
  "l_name" varchar(20),
  "sex" varchar(1),
  "desig" varchar(40),
  "present_address" varchar(200),
  "permanent_address" varchar(200),
  "wingno" varchar(6),
  "officeno" int4 NOT NULL,
  "age" varchar(2),
  "dob" timestamp,
  "date_of_appt" timestamp,
  "dor" timestamp,
  "permanetdate" timestamp,
  "quasiperdate" timestamp,
  "supanuationdate" timestamp,
  "gross_salary" numeric,
  "basic_pay" numeric,
  "nominee_name" varchar(40),
  "nominee_address" varchar(200),
  "nominee_relation" varchar(25),
  "declare_date" timestamp,
  "flg_retire" varchar(1),
  "memb_date" timestamp,
  "pfno" varchar(10),
  "lfno" varchar(10),
  "flg_incometax" varchar(2),
  "flg_insured" varchar(1),
  "insureamt" numeric,
  "remarks" varchar(100),
  "deletedon" timestamp
);


-- Table: member_transfer (110 rows)
CREATE TABLE IF NOT EXISTS "member_transfer" (
  "membertransferid" int4 NOT NULL,
  "dateoftransfer" timestamp,
  "fromofficeno" int4,
  "toofficeno" int4,
  "frommbno" numeric,
  "tombno" numeric,
  "enteredby" varchar(20)
);


-- Table: membercategory (7000 rows)
CREATE TABLE IF NOT EXISTS "membercategory" (
  "mbno" numeric,
  "categorycode" int4 NOT NULL,
  "membertype" int4
);


-- Table: members (10 rows)
CREATE TABLE IF NOT EXISTS "members" (
  "id" int4 NOT NULL,
  "memberNumber" varchar(20) NOT NULL,
  "firstName" varchar(50) NOT NULL,
  "lastName" varchar(50) NOT NULL,
  "dateOfBirth" date NOT NULL,
  "address" text NOT NULL,
  "phoneNumber" varchar(15) NOT NULL,
  "email" varchar(100),
  "aadharNumber" varchar(20),
  "panNumber" varchar(10),
  "occupation" varchar(50),
  "shareAmount" numeric NOT NULL,
  "signatureImagePath" varchar,
  "status" varchar NOT NULL,
  "createdAt" timestamp NOT NULL,
  "updatedAt" timestamp NOT NULL,
  "deletedAt" timestamp
);


-- Table: membertypemaster (4 rows)
CREATE TABLE IF NOT EXISTS "membertypemaster" (
  "id" int4 NOT NULL,
  "membertype" varchar(30)
);


-- Table: menumaster (92 rows)
CREATE TABLE IF NOT EXISTS "menumaster" (
  "menuid" int4 NOT NULL,
  "menuname" varchar(50),
  "menudesc" varchar(50),
  "visibleflag" varchar(1)
);


-- Table: mpjint (10 rows)
CREATE TABLE IF NOT EXISTS "mpjint" (
  "id" numeric,
  "mbno" numeric,
  "wrno" varchar(20),
  "opbal" numeric,
  "totdr" numeric,
  "totcr" numeric,
  "closebal" numeric,
  "amount" money NOT NULL,
  "interest" money NOT NULL,
  "post" varchar(1),
  "paid" varchar(1),
  "paydate" timestamp,
  "vchrno" varchar(6)
);


-- Table: nanded_united (10 rows)
CREATE TABLE IF NOT EXISTS "nanded_united" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: oic1 (10 rows)
CREATE TABLE IF NOT EXISTS "oic1" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: oic2 (10 rows)
CREATE TABLE IF NOT EXISTS "oic2" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: oic3 (10 rows)
CREATE TABLE IF NOT EXISTS "oic3" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: parameter_setting (11 rows)
CREATE TABLE IF NOT EXISTS "parameter_setting" (
  "param_code" varchar(30),
  "param_value" varchar(10),
  "param_desc" varchar(100)
);


-- Table: pl2bsac (10 rows)
CREATE TABLE IF NOT EXISTS "pl2bsac" (
  "maincode" int4 NOT NULL,
  "accode" varchar(5),
  "bankheadcode" varchar(4)
);


-- Table: rd_installments (10 rows)
CREATE TABLE IF NOT EXISTS "rd_installments" (
  "id" int4 NOT NULL,
  "recurringDepositId" int4,
  "installmentNumber" int4,
  "amount" numeric,
  "dueDate" date,
  "paidDate" date,
  "paidAmount" numeric,
  "penaltyAmount" numeric,
  "status" varchar(20),
  "remarks" text,
  "receiptNumber" varchar(20),
  "paymentMode" varchar(20),
  "createdAt" timestamp,
  "updatedAt" timestamp
);


-- Table: recurring_deposits (10 rows)
CREATE TABLE IF NOT EXISTS "recurring_deposits" (
  "id" int4 NOT NULL,
  "accountNumber" varchar(20),
  "memberId" int4,
  "monthlyInstallment" numeric,
  "interestRate" numeric,
  "startDate" date,
  "maturityDate" date,
  "tenureMonths" int4,
  "maturityAmount" numeric,
  "totalDeposited" numeric,
  "interestAccrued" numeric,
  "installmentsPaid" int4,
  "installmentsMissed" int4,
  "status" varchar(20),
  "closureDate" date,
  "closureAmount" numeric,
  "penaltyAmount" numeric,
  "closureReason" text,
  "lastInstallmentDate" date,
  "nextDueDate" date,
  "createdAt" timestamp,
  "updatedAt" timestamp,
  "deletedAt" timestamp
);


-- Table: relation_master (10 rows)
CREATE TABLE IF NOT EXISTS "relation_master" (
  "relation_id" numeric,
  "relation_name" varchar(20)
);


-- Table: ro_national (10 rows)
CREATE TABLE IF NOT EXISTS "ro_national" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: ro_united (10 rows)
CREATE TABLE IF NOT EXISTS "ro_united" (
  "mbno" float8,
  "name" varchar(255),
  "pfno" float8,
  "wingno" float8,
  "officeno" float8,
  "SHARE" float8,
  "rd" float8,
  "PREV LT" float8,
  "lt" float8,
  "field10" float8,
  "field11" float8,
  "PREV ST" float8,
  "st" float8,
  "field14" float8,
  "field15" float8
);


-- Table: society_details (1 rows)
CREATE TABLE IF NOT EXISTS "society_details" (
  "name" varchar(100),
  "address" varchar(100),
  "regno" varchar(30),
  "phone1" varchar(50),
  "phone2" varchar(50),
  "fax" varchar(50),
  "week_holiday" varchar(10),
  "authshare" money NOT NULL,
  "pan_number" varchar(50)
);


-- Table: suretymaster (6 rows)
CREATE TABLE IF NOT EXISTS "suretymaster" (
  "mbno" numeric,
  "amount" money NOT NULL,
  "g1mbno" numeric,
  "g2mbno" numeric,
  "g1amt" money NOT NULL,
  "g2amt" money NOT NULL,
  "addflag" varchar(1)
);


-- Table: sysdiagrams (10 rows)
CREATE TABLE IF NOT EXISTS "sysdiagrams" (
  "name" varchar(128),
  "principal_id" int4 NOT NULL,
  "diagram_id" int4 NOT NULL,
  "version" int4,
  "definition" bytea
);


-- Table: system_configs (10 rows)
CREATE TABLE IF NOT EXISTS "system_configs" (
  "id" int4 NOT NULL,
  "key" varchar(50),
  "name" varchar(100),
  "description" text,
  "value" text,
  "dataType" varchar(20),
  "category" varchar(50),
  "isActive" bool,
  "isReadonly" bool,
  "validationRules" text,
  "defaultValue" varchar(255),
  "unit" varchar(20),
  "createdAt" timestamp,
  "updatedAt" timestamp
);


-- Table: tblcashbook (6175 rows)
CREATE TABLE IF NOT EXISTS "tblcashbook" (
  "headcode" varchar(10),
  "headname" varchar(100),
  "rcash" numeric,
  "rtransfer" numeric,
  "pcash" numeric,
  "ptransfer" numeric,
  "trans_date" date
);


-- Table: tblmembdetledger (10 rows)
CREATE TABLE IF NOT EXISTS "tblmembdetledger" (
  "membno" numeric,
  "code" varchar(10),
  "crdrbody" varchar(5),
  "trans_date" timestamp,
  "trans_no" int8,
  "head_name" varchar(150),
  "vchr_no" varchar(6),
  "receipt" numeric,
  "payment" numeric,
  "trans_type" varchar(4),
  "balance" numeric
);


-- Table: tblmemberdetledgerhead (8 rows)
CREATE TABLE IF NOT EXISTS "tblmemberdetledgerhead" (
  "membno" numeric,
  "code" varchar(10),
  "headbalance" numeric,
  "baltype" varchar(6)
);


-- Table: tblmembrectotal (9578 rows)
CREATE TABLE IF NOT EXISTS "tblmembrectotal" (
  "code" varchar(6),
  "recipett" numeric,
  "paymentt" numeric
);


-- Table: transactions (15 rows)
CREATE TABLE IF NOT EXISTS "transactions" (
  "trans_no" int4 NOT NULL,
  "trans_type" varchar(2),
  "trans_date" timestamp NOT NULL,
  "mbno" numeric,
  "acc_no" numeric,
  "acc_type" varchar(4),
  "trans_amt" money NOT NULL,
  "receipt_vchr_no" varchar(6),
  "vchr_type" varchar(2),
  "modeofpay" varchar(2),
  "cheq_no" varchar(10),
  "cheq_amt" money NOT NULL,
  "cheq_date" timestamp,
  "bankname" varchar(75),
  "pass_flag" varchar(1),
  "cashier_flag" varchar(1),
  "code" varchar(5),
  "narration" varchar(100),
  "username" varchar(50),
  "cust_bank_name" varchar(100)
);


-- Table: trf_slab (10 rows)
CREATE TABLE IF NOT EXISTS "trf_slab" (
  "fromdate" timestamp,
  "uptodate" timestamp,
  "amount" money
);


-- Table: user_activities (10 rows)
CREATE TABLE IF NOT EXISTS "user_activities" (
  "id" int4 NOT NULL,
  "userId" int4,
  "activityType" varchar(50),
  "description" text,
  "ipAddress" varchar(50),
  "userAgent" text,
  "createdAt" timestamp
);


-- Table: userinfo (2 rows)
CREATE TABLE IF NOT EXISTS "userinfo" (
  "userid" int4 NOT NULL,
  "hostname" varchar(20),
  "abnormal_status" varchar(1)
);


-- Table: userleveldefaultrights (144 rows)
CREATE TABLE IF NOT EXISTS "userleveldefaultrights" (
  "userlevelid" int2 NOT NULL,
  "menuid" int4 NOT NULL
);


-- Table: userlevelmaster (10 rows)
CREATE TABLE IF NOT EXISTS "userlevelmaster" (
  "userlevelid" int2 NOT NULL,
  "userlevel" varchar(20)
);


-- Table: usermaster (23 rows)
CREATE TABLE IF NOT EXISTS "usermaster" (
  "userid" int4 NOT NULL,
  "susername" varchar(20),
  "spassword" varchar(20),
  "userlevelid" int2 NOT NULL,
  "enable_disable" varchar(1),
  "date_of_creation" timestamp,
  "date_of_disable_enable" timestamp,
  "login_status" varchar(1),
  "pass_transaction_flag" varchar(1)
);


-- Table: userrights (1910 rows)
CREATE TABLE IF NOT EXISTS "userrights" (
  "userid" int4 NOT NULL,
  "menuid" int4 NOT NULL
);


-- Table: users (10 rows)
CREATE TABLE IF NOT EXISTS "users" (
  "id" int4 NOT NULL,
  "username" varchar(50),
  "email" varchar(100),
  "password" varchar(255),
  "firstName" varchar(50),
  "lastName" varchar(50),
  "role" varchar(20),
  "permissions" text,
  "isActive" bool,
  "lastLoginAt" timestamp,
  "createdAt" timestamp,
  "updatedAt" timestamp
);


-- Table: voucher_master (2 rows)
CREATE TABLE IF NOT EXISTS "voucher_master" (
  "p_vchr_no" varchar(6),
  "r_vchr_no" varchar(6),
  "j_vchr_no" varchar(6),
  "d_vchr_no" varchar(6)
);


-- Table: vouchers (10 rows)
CREATE TABLE IF NOT EXISTS "vouchers" (
  "id" int4 NOT NULL,
  "voucherNumber" varchar(50),
  "voucherDate" date,
  "voucherType" varchar(20),
  "totalAmount" numeric,
  "description" text,
  "memberId" int4,
  "payeeName" varchar(100),
  "chequeNumber" varchar(20),
  "chequeDate" date,
  "bankName" varchar(100),
  "status" varchar(20),
  "remarks" text,
  "authorizedBy" int4,
  "authorizedAt" timestamp,
  "cancelledBy" int4,
  "cancelledAt" timestamp,
  "cancellationReason" text,
  "createdAt" timestamp,
  "updatedAt" timestamp,
  "deletedAt" timestamp
);


-- Table: wingmast (10 rows)
CREATE TABLE IF NOT EXISTS "wingmast" (
  "wingno" varchar(6),
  "wname" varchar(45),
  "winstate" int2 NOT NULL
);


-- Table: yearend (10 rows)
CREATE TABLE IF NOT EXISTS "yearend" (
  "yearcode" int4 NOT NULL,
  "start_date" timestamp,
  "end_date" timestamp,
  "username" varchar(40)
);


-- Table: yearend_head (10 rows)
CREATE TABLE IF NOT EXISTS "yearend_head" (
  "yearcode" numeric,
  "head_code" varchar(5),
  "parent_code" varchar(5),
  "closing_bal" numeric
);


-- Table: yearend_member (10 rows)
CREATE TABLE IF NOT EXISTS "yearend_member" (
  "yearcode" int2,
  "acc_type" varchar(4),
  "mbno" varchar(10),
  "balance" money
);


