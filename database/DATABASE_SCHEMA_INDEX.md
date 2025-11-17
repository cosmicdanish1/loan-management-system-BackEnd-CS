# 📊 Database Schema Index

Complete index of all tables in the Loan Management System database.

## 📋 Table Categories

### 1. **User Authentication & Authorization** (01-users-and-auth.sql)
- `usermaster` - User accounts and authentication
- `userlevelmaster` - User roles/levels
- `menumaster` - System menu items
- `userrights` - User-specific menu access
- `userleveldefaultrights` - Default rights per user level
- `userinfo` - User session information
- `logintime` - Login/logout tracking

### 2. **Member Management** (02-members.sql)
- `member_master` - Main member information
- `member_masterdelete` - Deleted member audit trail
- `membercategory` - Member categorization
- `membertypemaster` - Member type definitions
- `castcategorymaster` - Caste/category classifications
- `relation_master` - Relationship types
- `wingmast` - Wings/branches
- `division_master` - Divisions/offices
- `funds_master` - Member fund balances

### 3. **Account Management - FD/RD/SB** (03-accounts.sql)
- `fdmaster` - Fixed Deposit accounts
- `fdmasterhistory` - FD modification history
- `fdrd_slab_details` - Interest rate slabs
- `fdrdlienmaster` - FD/RD lien information
- `fd_interest_master` - FD interest calculations
- `interestpaid` - Interest payment records
- `interestmaster` - Interest rate master
- `bank_saving_product` - Savings account products
- `bank_sbintcalverify` - SB interest verification
- `bank_saving_detail_product` - Savings product details
- `jointmaster` - Joint account holders

### 4. **Loan Management** (04-loans.sql)
- `loan_master` - Active loan accounts
- `loan_masterhistory` - Loan modification history
- `loan_nominee` - Loan nominees
- `loan_pending` - Pending loan applications
- `loan_limit_master` - Loan limit configurations
- `suretymaster` - Surety/guarantor information
- `guarrenter_mast` - Guarantor balances

### 5. **Transactions & Vouchers** (05-transactions.sql)
- `transactions` - All financial transactions
- `ledger` - General ledger entries
- `voucher_master` - Voucher number tracking
- `daily_gl_history` - Daily GL balances
- `demand_receipt` - Demand-based receipts

### 6. **Demand & Recovery** (06-demand-recovery.sql)
- `demand_master` - Monthly demand generation
- `demand_masterdelete` - Deleted demand records
- `demandprintorder` - Demand print configuration
- `demandbyhand` - Manual demand entries
- `demandbyhanddeleted` - Deleted manual demands
- `access_recovery` - Short recovery tracking

### 7. **Financial Reporting** (07-reports.sql)
- `balancesheet` - Balance sheet data
- `balsheet` - Balance sheet working table
- `pl2bsac` - P&L to Balance Sheet mapping
- `annualstatement` - Annual member statements
- `mpjint` - Interest calculations

### 8. **System Configuration** (08-system-config.sql)
- `busrules` - Business rules and parameters
- `parameter_setting` - System parameters
- `headtype` - Account head types
- `headmaster` - Chart of accounts
- `head_master` - Head master working table
- `main` - Main account categories
- `operationmodemaster` - Operation modes
- `society_details` - Society information
- `getworkingdate` - Current working date

### 9. **Year End & Closing** (09-year-end.sql)
- `yearend` - Financial year definitions
- `yearend_head` - Year-end head balances
- `yearend_member` - Year-end member balances
- `bankopbal` - Bank opening balances

### 10. **Banking & Reconciliation** (10-banking.sql)
- `bank_cheq_master` - Cheque tracking
- (Bank reconciliation tables)

### 11. **Temporary & Working Tables** (11-temp-tables.sql)
- `temp_division_master` - Temporary division data
- `temp_alm` - Temporary ALM data
- `temp_rd` - Temporary RD data
- `temp_fd` - Temporary FD data
- `dumm_1ledger` - Dummy ledger for testing
- `convertmember` - Member conversion utility
- `pivot` - Pivot table for reports

### 12. **Regional/Branch Specific** (12-regional-tables.sql)
- `akola_national` - Akola National branch
- `akola_united` - Akola United branch
- `amravati_national` - Amravati National branch
- `amravati_united` - Amravati United branch
- `aurangabad_unitd` - Aurangabad United branch
- `jalgaon_united` - Jalgaon United branch
- `nanded_united` - Nanded United branch
- `ro_national` - RO National branch
- `ro_united` - RO United branch
- `doi_national` - DOI National branch
- `doi_united` - DOI United branch
- `doii_national` - DOII National branch
- `doii_united` - DOII United branch
- `doiii_national` - DOIII National branch
- `doiv_national` - DOIV National branch
- `dov_national` - DOV National branch
- `oic1`, `oic2`, `oic3` - OIC branches
- `Sheet1$Print_Area` - Print area data
- `results` - Results table

## 📊 Total Table Count

**Total Tables**: ~85+ tables

## 🔑 Key Relationships

### Primary Relationships:
1. **Members → Accounts**: `member_master.mbno` → `fdmaster.mbno`, `loan_master.mbno`
2. **Members → Funds**: `member_master.mbno` → `funds_master.mbno`
3. **Members → Demand**: `member_master.mbno` → `demand_master.mbno`
4. **Accounts → Transactions**: `fdmaster.account_number` → `transactions.acc_no`
5. **Users → Rights**: `usermaster.userid` → `userrights.userid`
6. **Wings → Divisions**: `wingmast.wingno` → `division_master.wingno`
7. **Loans → Nominees**: `loan_master.loancaseno` → `loan_nominee.loancaseno`

## 📝 Naming Conventions

### Table Prefixes:
- `member_*` - Member-related tables
- `loan_*` - Loan-related tables
- `fd*` - Fixed Deposit tables
- `bank_*` - Banking-related tables
- `demand_*` - Demand/recovery tables
- `temp_*` - Temporary working tables
- `*_master` - Master/configuration tables
- `*_history` - Historical/audit tables
- `*delete*` - Deleted record audit trails

### Column Naming:
- `*_id` - Primary key identifiers
- `*_no` - Number fields (member_no, account_no)
- `*_date` - Date/timestamp fields
- `*_amt` / `*_amount` - Monetary values
- `*_flag` - Boolean/status flags
- `op*` / `*opbal` - Opening balance fields
- `*_code` - Code/reference fields

## 🔍 Quick Reference

### Find Member Information:
```sql
SELECT * FROM member_master WHERE mbno = ?;
```

### Find Member Accounts:
```sql
SELECT * FROM fdmaster WHERE mbno = ? AND fdrdflag = 'F'; -- Fixed Deposits
SELECT * FROM fdmaster WHERE mbno = ? AND fdrdflag = 'R'; -- Recurring Deposits
SELECT * FROM fdmaster WHERE mbno = ? AND fdrdflag = 'S'; -- Savings Bank
```

### Find Member Loans:
```sql
SELECT * FROM loan_master WHERE mbno = ?;
```

### Find Member Transactions:
```sql
SELECT * FROM transactions WHERE mbno = ? ORDER BY trans_date DESC;
```

### Find User Access Rights:
```sql
SELECT m.* FROM menumaster m
JOIN userrights ur ON m.menuid = ur.menuid
WHERE ur.userid = ?;
```

## 📚 Documentation Files

- **Schemas**: `backend/database/schemas/*.sql`
- **Migrations**: `backend/database/migrations/*.sql`
- **Seeds**: `backend/database/seeds/*.sql`
- **Queries**: `backend/database/queries/*.sql`

## 🔄 Last Updated

**Date**: November 2024  
**Source**: EMP.sql  
**Database**: PostgreSQL 15.x  
**Total Lines**: 1883 lines


---

## 📁 Individual Schema Files Created

The following schema files have been extracted from EMP.sql for documentation:

### Authentication & Authorization Tables:

1. **02-usermaster.sql** - User accounts table
2. **03-userlevelmaster.sql** - User roles/levels table  
3. **04-menumaster.sql** - System menu items table
4. **05-userrights.sql** - User-specific menu access table
5. **06-userleveldefaultrights.sql** - Default rights per user level table
6. **07-userinfo.sql** - User session information table
7. **08-logintime.sql** - Login/logout tracking table

### Usage:
```bash
# These tables already exist in the database
# Files are for documentation and reference only
# To recreate, execute in order:
psql -U postgres -d employeesociety_new -f backend/database/schemas/02-usermaster.sql
psql -U postgres -d employeesociety_new -f backend/database/schemas/03-userlevelmaster.sql
# ... and so on
```

### Authentication Flow:
```
1. User logs in → Check usermaster (credentials, enabled status)
2. Get user level → userlevelmaster
3. Load permissions → userrights + userleveldefaultrights
4. Filter menus → menumaster (based on permissions)
5. Create session → logintime (track login/logout)
6. Monitor activity → userinfo (hostname, abnormal status)
```
