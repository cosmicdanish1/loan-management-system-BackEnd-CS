# Backend Architecture Analysis & Restructuring Plan

## Document Information
- **Date**: January 07, 2026
- **Purpose**: Comprehensive analysis of the current backend architecture and step-by-step plan to restructure it for improved maintainability, stability, and scalability.
- **Scope**: Backend restructuring without changing frontend UI (only updating API calls if required)

---

## 1. Executive Summary

### Current State Assessment (FULL SCAN COMPLETED)

I scanned **39 service files** and **27 controller files** (66 total). Your backend follows a NestJS modular architecture, which is a **good foundation**. However, there are critical architectural issues causing the "fixing one thing breaks another" problem.

#### 🔴 Critical Files (Over 20KB - Require Immediate Attention)

| File | Size (bytes) | Lines | Risk Level |
|------|-------------|-------|------------|
| `report.service.ts` | **126,843** | 3,296 | 🔴 **CRITICAL** |
| `member.service.ts` | **52,087** | 1,510 | 🔴 **CRITICAL** |
| `loan.service.ts` | **34,719** | 1,048 | 🔴 Critical |
| `analytics-tracking.service.ts` | **23,957** | ~700 | 🔴 Critical |
| `data-consistency.service.ts` | **22,535** | ~650 | 🔴 Critical |
| `loan.controller.ts` | **21,441** | ~620 | 🔴 Critical |
| `system-health-monitoring.service.ts` | **21,122** | ~600 | 🔴 Critical |

#### 🟡 High Risk Files (10KB - 20KB - Need Restructuring)

| File | Size (bytes) | Risk Level |
|------|-------------|------------|
| `daybook.service.ts` | 13,234 | 🟡 High |
| `backup.service.ts` | 12,806 | 🟡 High |
| `balance.service.ts` | 12,354 | 🟡 High |
| `defaulter-tracking.service.ts` | 12,298 | 🟡 High |
| `auth.service.ts` | 12,042 | 🟡 High |
| `user-management.service.ts` | 11,894 | 🟡 High |
| `deposit.controller.ts` | 11,851 | 🟡 High |
| `utilities.service.ts` | 11,528 | 🟡 High |
| `system-config.controller.ts` | 10,969 | 🟡 High |
| `cashbook.service.ts` | 10,865 | 🟡 High |
| `search.service.ts` | 10,832 | 🟡 High |
| `member-ledger.service.ts` | 10,580 | 🟡 High |
| `interest-calculation.service.ts` | 10,481 | 🟡 High |
| `report.controller.ts` | 10,183 | 🟡 High |

#### 🟢 Well-Sized Files (Under 10KB - Good Examples)

| File | Size (bytes) | Status |
|------|-------------|--------|
| `deposit.service.ts` | 14,583 (420 lines) | 🟢 Acceptable |
| `transaction.service.ts` | 14,208 (430 lines) | � Acceptable |
| `signature.service.ts` | 7,061 | 🟢 Good |
| `general-ledger.service.ts` | 5,737 | 🟢 Good |
| `consolidation.service.ts` | 4,294 | 🟢 Good |

#### Summary Statistics
- **Total Service Files**: 39
- **Total Controller Files**: 27
- **Files Needing Restructuring**: 21 (32%)
- **Largest File**: `report.service.ts` at **126KB / 3,296 lines** (56 methods!)

### Root Cause Analysis
The primary issue is **"God Object" anti-pattern** - a single class that knows too much and does too much.

**Example: `MemberService` currently handles:**
1. Member CRUD operations
2. Member lookup/search
3. Member balance calculations
4. Loan case management
5. Loan application processing
6. Voucher generation
7. Pass transaction processing
8. Surety management

This violates the **Single Responsibility Principle (SRP)** - each class should have only one reason to change.

---

## 2. Identified Problems

### Problem 1: Tight Coupling
```
MemberService → Handles loan operations
LoanService → Also handles loan operations
Result: Overlapping responsibilities, unclear ownership
```

**Impact**: When you update loan logic in `MemberService`, it may conflict with `LoanService`.

### Problem 2: No Clear Domain Boundaries
```
/modules/member/member.service.ts includes:
  - saveLoanApplication()
  - generateNextLoanCaseNo()
  - updateLoanSanction()
  - generateLoanVoucher()
  - passTransaction()
  - changeLoanSurety()
```

These are **loan domain operations**, not member operations.

### Problem 3: Shared State Mutations
Multiple services directly query and update the same tables without coordination:
- `loan_pending` is modified by both `MemberService` and `LoanService`
- `suretymaster` is updated in `MemberService` but may affect `LoanService` logic

### Problem 4: No Service Isolation
When services share raw queries and table mutations, there's no isolation layer to prevent cascading failures.

---

## 3. Proposed Architecture

### Domain-Driven Design (DDD) Structure

```
backend/src/modules/
├── member/
│   ├── services/
│   │   ├── member-crud.service.ts          (Create, Read, Update, Delete)
│   │   ├── member-lookup.service.ts        (Search, Lookup)
│   │   ├── member-balance.service.ts       (Balance calculations)
│   │   └── signature.service.ts            (Existing - keep as-is)
│   ├── member.facade.ts                    (Orchestration layer)
│   ├── member.controller.ts                (Simplified - only routes)
│   └── member.module.ts
│
├── loan/
│   ├── services/
│   │   ├── loan-application.service.ts     (Application, Case Numbers)
│   │   ├── loan-sanction.service.ts        (Sanction, Approval)
│   │   ├── loan-disbursement.service.ts    (Voucher, Disbursement)
│   │   ├── loan-surety.service.ts          (Guarantor management) ← NEW
│   │   ├── loan-payment.service.ts         (Payment processing)
│   │   ├── interest-calculation.service.ts (Existing)
│   │   ├── defaulter-tracking.service.ts   (Existing)
│   │   └── payment-processing.service.ts   (Existing)
│   ├── loan.facade.ts                      (Orchestration layer)
│   ├── loan.controller.ts                  (Simplified)
│   └── loan.module.ts
│
├── transaction/
│   ├── services/
│   │   ├── voucher.service.ts              (Voucher CRUD)
│   │   ├── pass-transaction.service.ts     (Final posting) ← MOVE FROM MEMBER
│   │   └── ledger-posting.service.ts       (Ledger updates)
│   ├── transaction.facade.ts
│   └── transaction.module.ts
│
└── shared/
    ├── services/
    │   ├── sequence-generator.service.ts   (All sequential IDs)
    │   └── date-helper.service.ts          (Date utilities)
    └── shared.module.ts
```

---

## 4. Step-by-Step Restructuring Plan

### Phase 1: Create Shared Infrastructure (Week 1)
**Risk Level: 🟢 Low** - New files only, no existing code changes

#### Step 1.1: Create Sequence Generator Service
Consolidate all sequential number generation (member numbers, loan case numbers, voucher numbers).

**File**: `backend/src/modules/shared/services/sequence-generator.service.ts`

**Responsibilities**:
- `generateNextMemberNumber()`
- `generateNextLoanCaseNo()`
- `generateNextVoucherNumber()`
- `getNextVoucherId()`

**Current Location**: These are scattered across `MemberService`

#### Step 1.2: Create Shared Module
**File**: `backend/src/modules/shared/shared.module.ts`

```typescript
@Module({
  imports: [TypeOrmModule.forFeature([/* entities for sequences */])],
  providers: [SequenceGeneratorService],
  exports: [SequenceGeneratorService],
})
export class SharedModule {}
```

---

### Phase 2: Extract Member Sub-Services (Week 2)
**Risk Level: 🟡 Medium** - Internal refactoring, same API endpoints

#### Step 2.1: Create Member CRUD Service
Extract from `MemberService`:
- `create()`
- `findAll()`
- `findOne()`
- `update()`
- `remove()`
- `restore()`
- `findByMemberNumber()`

**File**: `backend/src/modules/member/services/member-crud.service.ts`

#### Step 2.2: Create Member Lookup Service
Extract from `MemberService`:
- `lookupMembers()`
- `getMemberDetailsByNumber()`

**File**: `backend/src/modules/member/services/member-lookup.service.ts`

#### Step 2.3: Create Member Balance Service
Extract from `MemberService`:
- `getMemberBalance()`
- `getStatistics()`

**File**: `backend/src/modules/member/services/member-balance.service.ts`

#### Step 2.4: Update Member Controller
Use dependency injection to call the appropriate sub-service.

---

### Phase 3: Extract Loan Sub-Services (Week 3)
**Risk Level: 🟡 Medium** - Relocate loan logic from MemberService to LoanModule

#### Step 3.1: Create Loan Application Service
Move from `MemberService` to **new file**:
- `saveLoanApplication()`
- `getMemberLoanCases()`
- `getAllLoanCases()`

**File**: `backend/src/modules/loan/services/loan-application.service.ts`

#### Step 3.2: Create Loan Sanction Service
Move from `MemberService`:
- `getSanctionedLoanCases()`
- `getLoanDetailsByCaseNo()`
- `updateLoanSanction()`

**File**: `backend/src/modules/loan/services/loan-sanction.service.ts`

#### Step 3.3: Create Loan Surety Service ⭐ (Critical for your current issue)
Move from `MemberService`:
- `changeLoanSurety()`

**File**: `backend/src/modules/loan/services/loan-surety.service.ts`

```typescript
@Injectable()
export class LoanSuretyService {
  constructor(
    @InjectRepository(LoanPending)
    private readonly loanPendingRepository: Repository<LoanPending>,
    @InjectRepository(SuretyMaster)
    private readonly suretyMasterRepository: Repository<SuretyMaster>,
  ) {}

  async changeSurety(caseNo: string, suretyData: { surety1: string; surety2?: string }) {
    // Single responsibility: Only handle surety changes
    // Transaction-safe operations
  }
}
```

#### Step 3.4: Create Loan Disbursement Service
Move from `MemberService`:
- `generateLoanVoucher()`

**File**: `backend/src/modules/loan/services/loan-disbursement.service.ts`

---

### Phase 4: Move Pass Transaction to Transaction Module (Week 4)
**Risk Level: 🟠 Higher** - Cross-module migration

#### Step 4.1: Create Pass Transaction Service
Move from `MemberService`:
- `passTransaction()`
- `getPendingVouchers()`

**File**: `backend/src/modules/transaction/services/pass-transaction.service.ts`

This belongs in the Transaction module because it involves:
- Voucher status updates
- Ledger postings
- Cashbook updates

---

### Phase 5: Update API Routes (Week 5)
**Risk Level: 🟡 Medium** - Frontend changes required

#### Current Problematic Routes (in MemberController):
```
PATCH  /members/loans/change-surety/:caseNo   → Should be in LoanController
POST   /members/loan-application              → Should be in LoanController
PATCH  /members/loans/sanction/:caseNo        → Should be in LoanController
POST   /members/loans/voucher                 → Should be in TransactionController
POST   /members/transactions/pass/:voucherNo  → Should be in TransactionController
```

#### New Recommended Routes:
```
PATCH  /loans/surety/:caseNo                  → LoanController
POST   /loans/application                     → LoanController
PATCH  /loans/sanction/:caseNo                → LoanController
POST   /transactions/vouchers                 → TransactionController
POST   /transactions/pass/:voucherNo          → TransactionController
```

#### Migration Strategy:
1. Add new routes in correct controllers
2. Keep old routes as **deprecated aliases** pointing to new services
3. Update frontend to use new routes
4. Remove deprecated routes after testing

---

## 5. Implementation Guidelines

### Guideline 1: Service Isolation Pattern
Each service should only:
- Inject repositories for its own domain
- Call other services through dependency injection (not raw queries)
- Never directly modify tables owned by another domain

```typescript
// ❌ BAD: LoanApplicationService directly updates member data
await queryRunner.query(`UPDATE member_master SET ...`);

// ✅ GOOD: LoanApplicationService calls MemberService
await this.memberService.updateMemberStatus(memberNo, 'LOAN_ACTIVE');
```

### Guideline 2: Transaction Coordination
For operations that span multiple domains, use a **Facade** pattern:

```typescript
@Injectable()
export class LoanFacadeService {
  constructor(
    private readonly applicationService: LoanApplicationService,
    private readonly sanctionService: LoanSanctionService,
    private readonly suretyService: LoanSuretyService,
  ) {}

  async processFullLoanApplication(data: any) {
    // Coordinates multiple services in a single transaction
  }
}
```

### Guideline 3: Testing Strategy
Each sub-service must have its own **unit test file**:
```
loan-application.service.ts     → loan-application.service.spec.ts
loan-sanction.service.ts        → loan-sanction.service.spec.ts
loan-surety.service.ts          → loan-surety.service.spec.ts
```

This ensures that when one component is tested and stable, changes to other components won't break it.

---

## 6. Frontend API Update Guide

### Changes Required for `Change Loan Surety`:

**Current Frontend Call**:
```typescript
fetch(`http://localhost:3001/api/v1/members/loans/change-surety/${caseNo}`, {
  method: 'PATCH',
  ...
});
```

**New Frontend Call (after Phase 5)**:
```typescript
fetch(`http://localhost:3001/api/v1/loans/surety/${caseNo}`, {
  method: 'PATCH',
  ...
});
```

### Backward Compatibility Period
During migration, both routes will work:
- Old route: `/members/loans/change-surety/:caseNo` (deprecated, logs warning)
- New route: `/loans/surety/:caseNo` (preferred)

---

## 7. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Breaking existing functionality | Keep old routes as aliases during migration |
| Data inconsistency during transition | Use database transactions for all multi-table operations |
| Frontend API calls failing | Test each route change in staging before production |
| Lost business logic during extraction | Create comprehensive test coverage before extraction |

---

## 8. Expected Outcomes

### Before Restructuring
- `member.service.ts`: 1,510 lines, 31 methods, handles 8+ domains
- Debugging: Hard to trace issues across mixed concerns
- Testing: Difficult to isolate and test individual features

### After Restructuring
- Each service: 200-400 lines, 5-10 focused methods
- Debugging: Clear domain ownership, easy to locate issues
- Testing: Each service testable in isolation
- Stability: Changes to one domain don't cascade to others

---

## 9. Recommended Immediate Actions

### Priority 1: Fix Current Issue (Today)
Move `changeLoanSurety()` from `MemberService` to a new `LoanSuretyService` in the loan module. This isolates the problematic logic.

### Priority 2: Create Shared Module (This Week)
Centralize sequence generators to prevent duplicate number issues.

### Priority 3: Start Member Service Extraction (Next Week)
Begin Phase 2 with the lowest-risk extractions (lookup, balance).

---

## 10. Appendix: Current Method Mapping

### MemberService Methods → Recommended New Location

| Method | Lines | New Service | New Module |
|--------|-------|-------------|------------|
| `create` | 29-101 | `MemberCrudService` | member |
| `findAll` | 103-183 | `MemberCrudService` | member |
| `getStatistics` | 185-206 | `MemberBalanceService` | member |
| `findOne` | 208-221 | `MemberCrudService` | member |
| `update` | 223-278 | `MemberCrudService` | member |
| `remove` | 280-293 | `MemberCrudService` | member |
| `lookupMembers` | 295-339 | `MemberLookupService` | member |
| `getMemberLoanCases` | 341-374 | `LoanApplicationService` | loan |
| `getMemberDetailsByNumber` | 376-422 | `MemberLookupService` | member |
| `saveMemberMaster` | 424-491 | `MemberCrudService` | member |
| `generateNextMemberNumber` | 493-524 | `SequenceGeneratorService` | shared |
| `getMemberBalance` | 526-720 | `MemberBalanceService` | member |
| `generateNextLoanCaseNo` | 722-743 | `SequenceGeneratorService` | shared |
| `saveLoanApplication` | 745-815 | `LoanApplicationService` | loan |
| `getAllLoanCases` | 817-855 | `LoanApplicationService` | loan |
| `getSanctionedLoanCases` | 857-895 | `LoanSanctionService` | loan |
| `getLoanDetailsByCaseNo` | 897-1003 | `LoanSanctionService` | loan |
| `updateLoanSanction` | 1005-1040 | `LoanSanctionService` | loan |
| `generateLoanVoucher` | 1042-1133 | `LoanDisbursementService` | loan |
| `getNextVoucherNumber` | 1135-1169 | `SequenceGeneratorService` | shared |
| `getNextVoucherId` | 1171-1191 | `SequenceGeneratorService` | shared |
| `getPendingVouchers` | 1193-1254 | `PassTransactionService` | transaction |
| `passTransaction` | 1256-1399 | `PassTransactionService` | transaction |
| `getLoanAccountCode` | 1401-1414 | `LoanSanctionService` | loan |
| `restore` | 1416-1453 | `MemberCrudService` | member |
| `changeLoanSurety` | 1455-1509 | `LoanSuretyService` | loan |

---

## Document End

This document serves as the master plan for restructuring. Each phase should be reviewed and approved before implementation. All changes should be made incrementally with thorough testing at each step.
