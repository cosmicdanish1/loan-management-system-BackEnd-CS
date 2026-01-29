# Archived Files - Backend Restructuring

## Archive Date: January 08, 2026

This folder contains archived copies of the original large service files that were
replaced by the V2 restructured services.

---

## ⚠️ WARNING

**DO NOT DELETE THESE FILES UNTIL PRODUCTION DEPLOYMENT IS VERIFIED**

These files serve as a backup and reference for the original implementations.
After 30 days of successful production operation, these can be safely deleted.

---

## Archived Files Reference

### Original File Sizes (Before Restructuring)

| File | Size | Lines | Methods | Archived As |
|------|------|-------|---------|-------------|
| `member.service.ts` | 52 KB | 1,510 | 25+ | See member-v2/services-v2/ |
| `loan.service.ts` | 35 KB | 1,048 | 20+ | See loan-v2/services-v2/ |
| `report.service.ts` | 127 KB | 3,296 | 56 | See report-v2/services-v2/ |

### Replacement Structure

#### Member Service → Split into:
- `member/services-v2/member-crud.service.ts` - CRUD operations
- `member/services-v2/member-lookup.service.ts` - Search/lookup
- `member/services-v2/member-balance.service.ts` - Balance calculations

#### Loan Service → Split into:
- `loan/services-v2/loan-application.service.ts` - Application handling
- `loan/services-v2/loan-sanction.service.ts` - Sanction operations
- `loan/services-v2/loan-surety.service.ts` - Guarantor management ⭐
- `loan/services-v2/loan-query.service.ts` - Loan queries

#### Transaction Module → Split into:
- `transaction/services-v2/voucher.service.ts` - Voucher generation
- `transaction/services-v2/pass-transaction.service.ts` - Final posting

#### Report Service (127KB) → Split into:
- `report/services-v2/cash-book-reports.service.ts` - Cash book reports
- `report/services-v2/member-reports.service.ts` - Member reports
- `report/services-v2/loan-reports.service.ts` - Loan reports
- `report/services-v2/dividend-reports.service.ts` - Dividend reports
- `report/services-v2/deposit-reports.service.ts` - Deposit reports
- `report/services-v2/utility-reports.service.ts` - Utility reports

---

## Rollback Instructions

If anything goes wrong, you can revert to using V1 by:

1. **Disable V2 in app.module.ts:**
   ```typescript
   // Comment out these lines:
   // MemberV2Module,
   // LoanV2Module,
   // TransactionV2Module,
   // ReportV2Module,
   ```

2. **Update frontend config:**
   ```typescript
   // In apiVersionConfig.ts, set all flags to false:
   USE_V2_MEMBER_API: false,
   USE_V2_LOAN_API: false,
   // etc.
   ```

3. The original services are still in place and will continue to work.

---

## Deletion Schedule

- [ ] Week 1: Monitor production for errors
- [ ] Week 2: Verify all V2 endpoints working correctly
- [ ] Week 3: Confirm no V1 calls in logs
- [ ] Week 4: Safe to delete original files

---

## Files Safe to Delete After Verification

These files can be deleted ONLY after 30 days of successful V2 operation:

```bash
# DO NOT RUN UNTIL VERIFIED
# src/modules/member/member.service.ts  # Keep for reference
# src/modules/loan/loan.service.ts      # Keep for reference
# src/modules/report/report.service.ts  # Keep for reference
```

---

## Contact

Migration completed by: AI Assistant with User
Date: January 08, 2026
Session: Backend Restructuring Phase 1-8
