# Backend Restructuring - Context Memory

## Purpose
This file stores all context about the backend restructuring project so that if a session is interrupted, the next session can continue where we left off.

---

## 📁 PROJECT STRUCTURE

### Workspace Location
```
f:\company\main project\
├── backend\          (NestJS Backend)
└── Frontend\         (React + Vite Frontend)
```

### Backend API
- **Port**: 3001
- **Base URL**: http://localhost:3001/api/v1
- **Framework**: NestJS with TypeORM
- **Database**: PostgreSQL

---

## 📊 FILES I HAVE SCANNED

### Critical Files (Fully Read/Analyzed)

| File | Path | Size | Lines | Methods |
|------|------|------|-------|---------|
| member.service.ts | `backend/src/modules/member/member.service.ts` | 52,087 bytes | 1,510 | 31 |
| member.controller.ts | `backend/src/modules/member/member.controller.ts` | 19,007 bytes | 560 | 30 |
| loan.service.ts | `backend/src/modules/loan/loan.service.ts` | 34,719 bytes | 1,048 | 32 |
| loan.controller.ts | `backend/src/modules/loan/loan.controller.ts` | 21,441 bytes | ~620 | ~25 |
| report.service.ts | `backend/src/modules/report/report.service.ts` | 126,843 bytes | 3,296 | 56 |
| app.module.ts | `backend/src/app.module.ts` | 5,927 bytes | 153 | - |
| member.module.ts | `backend/src/modules/member/member.module.ts` | 626 bytes | 16 | - |
| loan.module.ts | `backend/src/modules/loan/loan.module.ts` | 1,208 bytes | 31 | - |
| transaction.service.ts | `backend/src/modules/transaction/transaction.service.ts` | 14,208 bytes | 430 | 15 |
| deposit.service.ts | `backend/src/modules/deposit/deposit.service.ts` | 14,583 bytes | 420 | 21 |

---

## 🔍 METHOD MAPPING (member.service.ts)

These methods need to be moved OUT of member.service.ts:

### Methods → Shared Module
| Method | Lines | New Location |
|--------|-------|--------------|
| generateNextMemberNumber() | 493-524 | sequence-generator.service.ts |
| generateNextLoanCaseNo() | 722-743 | sequence-generator.service.ts |
| getNextVoucherNumber() | 1135-1169 | sequence-generator.service.ts |
| getNextVoucherId() | 1171-1191 | sequence-generator.service.ts |

### Methods → Member Services V2
| Method | Lines | New Location |
|--------|-------|--------------|
| create() | 29-101 | member-crud.service.ts |
| findAll() | 103-183 | member-crud.service.ts |
| findOne() | 208-221 | member-crud.service.ts |
| update() | 223-278 | member-crud.service.ts |
| remove() | 280-293 | member-crud.service.ts |
| restore() | 1416-1453 | member-crud.service.ts |
| saveMemberMaster() | 424-491 | member-crud.service.ts |
| lookupMembers() | 295-339 | member-lookup.service.ts |
| getMemberDetailsByNumber() | 376-422 | member-lookup.service.ts |
| getMemberBalance() | 526-720 | member-balance.service.ts |
| getStatistics() | 185-206 | member-balance.service.ts |

### Methods → Loan Services V2
| Method | Lines | New Location |
|--------|-------|--------------|
| getMemberLoanCases() | 341-374 | loan-application.service.ts |
| saveLoanApplication() | 745-815 | loan-application.service.ts |
| getAllLoanCases() | 817-855 | loan-application.service.ts |
| getSanctionedLoanCases() | 857-895 | loan-sanction.service.ts |
| getLoanDetailsByCaseNo() | 897-1003 | loan-sanction.service.ts |
| updateLoanSanction() | 1005-1040 | loan-sanction.service.ts |
| getLoanAccountCode() | 1401-1414 | loan-sanction.service.ts |
| generateLoanVoucher() | 1042-1133 | loan-disbursement.service.ts |
| changeLoanSurety() | 1455-1509 | loan-surety.service.ts ⭐ |

### Methods → Transaction Services V2
| Method | Lines | New Location |
|--------|-------|--------------|
| getPendingVouchers() | 1193-1254 | pass-transaction.service.ts |
| passTransaction() | 1256-1399 | pass-transaction.service.ts |

---

## 🔍 METHOD MAPPING (loan.service.ts)

| Method | Lines | Keep/Move |
|--------|-------|-----------|
| create() | 43-80 | Keep (combine with loan-application.service.ts) |
| findAll() | 82-147 | Keep |
| getStatistics() | 149-177 | Keep |
| getDefaulters() | 179-205 | Keep (or move to defaulter service) |
| findOne() | 207-221 | Keep |
| findByAccountNumber() | 223-237 | Keep |
| findByMember() | 239-253 | Keep |
| update() | 255-275 | Keep |
| disburse() | 277-292 | Move to loan-disbursement.service.ts |
| close() | 294-309 | Keep |
| recordPayment() | 311-352 | Keep (existing payment-processing.service.ts) |
| getPaymentHistory() | 354-379 | Keep |
| getEmiSchedule() | 381-406 | Keep |
| getEmiScheduleFromMaster() | 408-539 | Keep/Move to loan-query.service.ts |
| calculateInterest() | 541-573 | Keep (existing interest-calculation.service.ts) |
| updateSurety() | 575-585 | Move to loan-surety.service.ts |
| remove() | 587-598 | Keep |
| getMemberLoanFromMaster() | 600-643 | Move to loan-query.service.ts |
| getMemberLoanFromPending() | 645-697 | Move to loan-query.service.ts |
| getMemberLoansFromMaster() | 699-736 | Move to loan-query.service.ts |
| getMemberLoansFromPending() | 738-785 | Move to loan-query.service.ts |
| searchMemberLoans() | 787-896 | Move to loan-query.service.ts |

---

## 📋 CURRENT MIGRATION STATUS

| Phase | Status | Completion |
|-------|--------|------------|
| Phase 0: Setup | ⏳ Not Started | 0% |
| Phase 1: Shared Module | ⏳ Not Started | 0% |
| Phase 2: Member Module V2 | ⏳ Not Started | 0% |
| Phase 3: Loan Module V2 | ⏳ Not Started | 0% |
| Phase 4: Transaction Module V2 | ⏳ Not Started | 0% |
| Phase 5: Report Module V2 | ⏳ Not Started | 0% |
| Phase 6: Testing | ⏳ Not Started | 0% |
| Phase 7: Route Switching | ⏳ Not Started | 0% |
| Phase 8: Cleanup | ⏳ Not Started | 0% |

---

## 🐛 CURRENT ISSUE (from user conversation)

### Problem: Change Loan Surety not working
- **Frontend**: `ChangeLoanSurety.tsx` calls `/api/v1/members/loans/change-surety/:caseNo`
- **Backend**: `changeLoanSurety()` in member.service.ts (lines 1455-1509)
- **Issue**: Loan cases not loading for selected member

### Root Cause
- `changeLoanSurety()` is in `member.service.ts` but should be in loan module
- Mixed responsibilities causing confusion

### Solution (Phase 3, Step 3)
Create `loan-surety.service.ts` in loan module with clean, isolated implementation

---

## 📁 EXISTING GOOD SERVICES (Use as Examples)

These files are well-structured and can serve as templates:

| File | Size | Why It's Good |
|------|------|---------------|
| signature.service.ts | 7,061 bytes | Single responsibility, focused |
| consolidation.service.ts | 4,294 bytes | Simple, maintainable |
| interest-calculation.service.ts | 10,481 bytes | Already separated out |
| defaulter-tracking.service.ts | 12,298 bytes | Already separated out |
| payment-processing.service.ts | 19,962 bytes | Already in services/ folder |

---

## 📝 DOCUMENTS CREATED

| Document | Path | Purpose |
|----------|------|---------|
| Analysis | `backend/docs/BACKEND_RESTRUCTURING_PLAN.md` | Full analysis of problems |
| Safe Migration | `backend/docs/SAFE_MIGRATION_PLAN.md` | Detailed rollback-safe plan |
| Workflow | `backend/docs/IMPLEMENTATION_WORKFLOW.md` | Step-by-step guide |
| Context | `backend/docs/MIGRATION_CONTEXT.md` | This file - memory for AI |

---

## 🔄 HOW TO RESUME

If you start a new session, tell me:
```
"We are doing backend restructuring. Read the context file at:
backend/docs/MIGRATION_CONTEXT.md"
```

I will read this file and know:
1. Which files I've analyzed
2. Which methods go where
3. Current migration status
4. What we were working on

---

## Last Updated
- **Date**: January 07, 2026
- **Time**: 20:47 IST
- **Last Action**: Created planning documents
- **Next Action**: Wait for user to say "Let's start Phase 0"
