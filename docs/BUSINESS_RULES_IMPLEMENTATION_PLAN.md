# Business Rules Implementation Plan

## Overview
This document outlines the plan to integrate the `ModifyBusinessRules.tsx` frontend component with a robust backend implementation. Currently, many business logic constraints (like maximum loan amounts) are hardcoded in the backend services. We will migrate these to a centralized, database-driven configuration system.

---

## 1. Backend Analysis
### Hardcoded Bottlenecks
- [ ] **Loan Limits**: `LoanService.validateLoanEligibility` has a hardcoded ₹5,00,000 limit.
- [ ] **Interest Rates**: Many services currently use hardcoded percentage values for calculations.
- [ ] **Membership Duration**: Minimum membership months for loan eligibility.

---

## 2. Implementation Strategy

### Phase 1: Schema & Data Seeding
- [ ] Add missing keys to the `system_configs` table under the `business_rules` and `loan_settings` categories.
- [ ] Create a seeding script to populate default values matching the current hardcoded constants.

### Phase 2: Backend API Enhancements
- [ ] **Bulk Fetch API**: Implement `GET /admin/config/business-rules` that returns a nested object structure matching the frontend's `BusinessRulesData` interface.
- [ ] **Bulk Update API**: Implement `POST /admin/config/business-rules` to update multiple configuration keys in a single transaction.
- [ ] **Service Refactoring**: Replace hardcoded constants in `LoanService`, `MemberService`, and `TransactionService` with calls to `SystemConfigService.getConfigValue(key)`.

### Phase 3: Frontend Integration
- [ ] Create `useBusinessRules` hook for centralized state management.
- [ ] Integrate `ModifyBusinessRules.tsx` with the new backend endpoints.
- [ ] Implement validation in the frontend to match the backend's `validationRules`.

---

## 3. Business Rules Mapping

| Frontend Section | Backend Category | Backend Key Pattern |
|-----------------|------------------|---------------------|
| Loan Parameters | `loan_settings` | `loan_[type]_[param]` |
| General Settings | `system_settings` | `sys_[setting_name]` |
| Others/Penal | `business_rules` | `rule_[setting_name]` |

---

## 4. Proposed Timeline
- **Discovery**: Audit all services for hardcoded "magic numbers".
- **Development (Backend)**: Create bulk endpoints and refactor `LoanService`.
- **Development (Frontend)**: Wire up the `ModifyBusinessRules` page.
- **Verification**: Ensure changes in the dashboard immediately reflect in loan eligibility checks.

---

## 5. Success Criteria
1. Changing the **Maximum Loan Amount** in the UI to ₹10,00,000 should immediately allow the backend to process loans above ₹5,00,000.
2. The `ModifyBusinessRules` page should show actual database values on load.
3. All configuration changes must be audited (recorded in `updatedAt` and optionally a log table).
