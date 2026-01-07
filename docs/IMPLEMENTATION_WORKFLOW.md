# Implementation Workflow - Step by Step

## How We Will Work Together

### Our Process
```
1. You say: "Let's do Phase X, Step Y"
2. I will:
   - Show you what file I'm creating
   - Show you the code
   - Create the file (WITHOUT touching old files)
3. You test it
4. If it works → Move to next step
5. If it fails → We delete the new file, old system still works
```

---

## PHASE 0: Setup (Day 1)

### Step 0.1: Create Git Backup
**You run these commands:**
```bash
cd "f:\company\main project"
git add .
git commit -m "Backup before restructuring"
git checkout -b backup/pre-restructuring
git push origin backup/pre-restructuring
git checkout main
git checkout -b feature/backend-restructuring-v2
```

### Step 0.2: Create Folders
**I will create empty folders:**
```
backend/src/modules/shared/
backend/src/modules/shared/services/
backend/src/modules/member/services-v2/
backend/src/modules/loan/services-v2/
backend/src/modules/transaction/services-v2/
backend/src/modules/report/services-v2/
```

---

## PHASE 1: Shared Module (Day 2-3)

### Step 1.1: Create sequence-generator.service.ts
**I copy these methods from member.service.ts (lines 493-524, 722-743, 1135-1191):**
- `generateNextMemberNumber()`
- `generateNextLoanCaseNo()`
- `getNextVoucherNumber()`
- `getNextVoucherId()`

**New file:** `backend/src/modules/shared/services/sequence-generator.service.ts`

### Step 1.2: Create shared.module.ts
**New file:** `backend/src/modules/shared/shared.module.ts`

### Step 1.3: Register SharedModule
**I ADD one line to app.module.ts (no other changes)**

### Step 1.4: Test
**You restart backend and check for errors**

---

## PHASE 2: Member Module V2 (Day 4-6)

### Step 2.1: Create member-crud.service.ts
**I copy from member.service.ts:**
- Lines 29-101: `create()`
- Lines 103-183: `findAll()`
- Lines 208-221: `findOne()`
- Lines 223-278: `update()`
- Lines 280-293: `remove()`
- Lines 1416-1453: `restore()`
- Lines 424-491: `saveMemberMaster()`

**New file:** `backend/src/modules/member/services-v2/member-crud.service.ts`

### Step 2.2: Create member-lookup.service.ts
**I copy from member.service.ts:**
- Lines 295-339: `lookupMembers()`
- Lines 376-422: `getMemberDetailsByNumber()`

**New file:** `backend/src/modules/member/services-v2/member-lookup.service.ts`

### Step 2.3: Create member-balance.service.ts
**I copy from member.service.ts:**
- Lines 526-720: `getMemberBalance()`
- Lines 185-206: `getStatistics()`

**New file:** `backend/src/modules/member/services-v2/member-balance.service.ts`

### Step 2.4: Create member-v2.module.ts
**New file:** `backend/src/modules/member/member-v2.module.ts`

### Step 2.5: Create member-v2.controller.ts
**New routes under /v2/members/**

### Step 2.6: Register MemberV2Module
**I ADD to app.module.ts**

### Step 2.7: Test
**You test: GET /api/v1/v2/members should return same data as GET /api/v1/members**

---

## PHASE 3: Loan Module V2 (Day 7-9)

### Step 3.1: Create loan-application.service.ts
**I copy from member.service.ts:**
- Lines 341-374: `getMemberLoanCases()`
- Lines 745-815: `saveLoanApplication()`
- Lines 817-855: `getAllLoanCases()`

**New file:** `backend/src/modules/loan/services-v2/loan-application.service.ts`

### Step 3.2: Create loan-sanction.service.ts
**I copy from member.service.ts:**
- Lines 857-895: `getSanctionedLoanCases()`
- Lines 897-1003: `getLoanDetailsByCaseNo()`
- Lines 1005-1040: `updateLoanSanction()`
- Lines 1401-1414: `getLoanAccountCode()`

**New file:** `backend/src/modules/loan/services-v2/loan-sanction.service.ts`

### Step 3.3: Create loan-surety.service.ts ⭐ (YOUR CURRENT ISSUE)
**I copy from member.service.ts:**
- Lines 1455-1509: `changeLoanSurety()`

**New file:** `backend/src/modules/loan/services-v2/loan-surety.service.ts`

### Step 3.4: Create loan-disbursement.service.ts
**I copy from member.service.ts:**
- Lines 1042-1133: `generateLoanVoucher()`

**New file:** `backend/src/modules/loan/services-v2/loan-disbursement.service.ts`

### Step 3.5: Create loan-v2.module.ts and loan-v2.controller.ts

### Step 3.6: Test
**You test: PATCH /api/v1/v2/loans/surety/:caseNo**

---

## PHASE 4: Transaction Module V2 (Day 10-11)

### Step 4.1: Create pass-transaction.service.ts
**I copy from member.service.ts:**
- Lines 1193-1254: `getPendingVouchers()`
- Lines 1256-1399: `passTransaction()`

**New file:** `backend/src/modules/transaction/services-v2/pass-transaction.service.ts`

### Step 4.2: Create voucher.service.ts

### Step 4.3: Create transaction-v2.module.ts and controller

### Step 4.4: Test

---

## PHASE 5: Report Module V2 (Day 12-15)

### Step 5.1-5.8: Split report.service.ts (3296 lines) into 8 services
Each service: ~400 lines

### Step 5.9: Create report-v2.module.ts and controller

### Step 5.10: Test all report endpoints

---

## PHASE 6: Testing (Day 16-18)

### Step 6.1: Compare V1 vs V2 responses
For each endpoint, verify V2 returns same data as V1

### Step 6.2: Performance testing

---

## PHASE 7: Route Switching (Day 19-20)

### Step 7.1: Create feature flags
### Step 7.2: Enable flags one by one
### Step 7.3: Update frontend API calls

---

## PHASE 8: Cleanup (Day 21+)

### Step 8.1: Archive old files (DON'T DELETE)
### Step 8.2: Rename v2 files to standard names

---

## Commands for Each Session

When you're ready to start, just say:
- "Let's start Phase 0"
- "Continue with Phase 1, Step 1"
- "Let's do Phase 3, Step 3" (for loan surety - your current issue)

I will:
1. Show you the code
2. Create the file
3. Tell you how to test
4. Wait for your confirmation before next step
