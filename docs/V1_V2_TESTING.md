# V1 vs V2 Endpoint Testing Guide

## Last Updated: January 08, 2026 - 04:12 IST

This document tracks the testing of V1 (original) vs V2 (new) endpoints to ensure functional parity.

---

## 🧪 Testing Methodology

1. Call V1 endpoint
2. Call equivalent V2 endpoint
3. Compare response structure
4. Verify data accuracy
5. Note any differences

---

## ✅ Member Endpoints

### GET All Members
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `GET /api/v1/members` | ✅ Working |
| V2 | `GET /api/v1/v2/members` | ✅ Working |

**Response Comparison:** ✅ Same structure

### GET Member by ID
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `GET /api/v1/members/:id` | ✅ Working |
| V2 | `GET /api/v1/v2/members/:id` | ✅ Working |

### Member Lookup
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `GET /api/v1/members/lookup` | ✅ Working |
| V2 | `GET /api/v1/v2/members/lookup/search` | ✅ Working |

### Member Balance
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `GET /api/v1/members/balance/:memberNo` | ✅ Working |
| V2 | `GET /api/v1/v2/members/balance/:memberNo` | ✅ Working |

---

## ✅ Loan Endpoints

### GET All Loan Cases
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `GET /api/v1/members/loan-cases` | ✅ Working |
| V2 | `GET /api/v1/v2/loans/cases` | ✅ Working |

### GET Loan Details
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `GET /api/v1/members/loan-details/:caseNo` | ✅ Working |
| V2 | `GET /api/v1/v2/loans/case/:caseNo` | ✅ Working |

### Change Loan Surety ⭐
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `PATCH /api/v1/members/change-surety/:caseNo` | ✅ Working |
| V2 | `PATCH /api/v1/v2/loans/surety/:caseNo` | ✅ Working |

**Note:** V2 endpoint is cleaner and more RESTful.

---

## ✅ Transaction Endpoints

### GET Pending Vouchers
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `GET /api/v1/members/pending-vouchers` | ✅ Working |
| V2 | `GET /api/v1/v2/transactions/vouchers/pending` | ✅ Working |

### Generate Voucher
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `POST /api/v1/members/generate-voucher` | ✅ Working |
| V2 | `POST /api/v1/v2/transactions/voucher` | ✅ Working |

### Pass Transaction
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `POST /api/v1/members/pass-transaction/:voucherNo` | ✅ Working |
| V2 | `POST /api/v1/v2/transactions/pass/:voucherNo` | ✅ Working |

---

## ✅ Report Endpoints

### Cash Book Monthly
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `POST /api/v1/reports/cashbook-monthly` | ✅ Working |
| V2 | `POST /api/v1/v2/reports/cashbook/monthly` | ✅ Working |

### Head List
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `GET /api/v1/reports/heads` | ✅ Working |
| V2 | `GET /api/v1/v2/reports/heads` | ✅ Working |

### Wing List
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `GET /api/v1/reports/wings` | ✅ Working |
| V2 | `GET /api/v1/v2/reports/wings` | ✅ Working |

### Loan Types
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `GET /api/v1/reports/loan-types` | ✅ Working |
| V2 | `GET /api/v1/v2/reports/loan-types` | ✅ Working |

### Defaulter List
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `POST /api/v1/reports/defaulter-list` | ✅ Working |
| V2 | `POST /api/v1/v2/reports/defaulters` | ✅ Working |

### Member Profile
| Version | Endpoint | Status |
|---------|----------|--------|
| V1 | `POST /api/v1/reports/member-profile` | ✅ Working |
| V2 | `GET /api/v1/v2/reports/member/profile/:memberNo` | ✅ Working |

---

## 📊 Testing Summary

| Module | V1 Endpoints | V2 Endpoints | Tested | Passed |
|--------|-------------|--------------|--------|--------|
| Member | 8 | 8 | ✅ | ✅ |
| Loan | 6 | 6 | ✅ | ✅ |
| Transaction | 4 | 4 | ✅ | ✅ |
| Report | 30+ | 30+ | ✅ | ✅ |

---

## 🔄 V1 → V2 Route Mapping

### Member Routes
```
V1: /api/v1/members              → V2: /api/v1/v2/members
V1: /api/v1/members/lookup       → V2: /api/v1/v2/members/lookup/search
V1: /api/v1/members/balance/:no  → V2: /api/v1/v2/members/balance/:no
V1: /api/v1/members/statistics   → V2: /api/v1/v2/members/statistics
```

### Loan Routes
```
V1: /api/v1/members/loan-cases       → V2: /api/v1/v2/loans/cases
V1: /api/v1/members/loan-details/:no → V2: /api/v1/v2/loans/case/:no
V1: /api/v1/members/change-surety/:no → V2: /api/v1/v2/loans/surety/:no
V1: /api/v1/members/sanctioned-loans → V2: /api/v1/v2/loans/sanctioned
```

### Transaction Routes
```
V1: /api/v1/members/pending-vouchers     → V2: /api/v1/v2/transactions/vouchers/pending
V1: /api/v1/members/generate-voucher     → V2: /api/v1/v2/transactions/voucher
V1: /api/v1/members/pass-transaction/:no → V2: /api/v1/v2/transactions/pass/:no
```

### Report Routes
```
V1: /api/v1/reports/cashbook-monthly → V2: /api/v1/v2/reports/cashbook/monthly
V1: /api/v1/reports/heads            → V2: /api/v1/v2/reports/heads
V1: /api/v1/reports/wings            → V2: /api/v1/v2/reports/wings
V1: /api/v1/reports/defaulter-list   → V2: /api/v1/v2/reports/defaulters
V1: /api/v1/reports/member-profile   → V2: /api/v1/v2/reports/member/profile/:no
```

---

## ✅ Test Completion Checklist

- [x] Member CRUD operations tested
- [x] Member lookup tested
- [x] Member balance tested
- [x] Loan cases tested
- [x] Loan details tested
- [x] Loan surety change tested
- [x] Pending vouchers tested
- [x] Voucher generation tested
- [x] Pass transaction tested
- [x] Cash book reports tested
- [x] Member reports tested
- [x] Loan reports tested
- [x] Utility reports tested

---

## 🎯 Phase 6 Result: PASSED ✅

All critical endpoints have been tested and are working correctly.
V2 endpoints provide equivalent functionality to V1 endpoints.
