# PostgreSQL Migration Fixes

## Overview
This document lists all the changes made to convert SQLite-specific TypeORM entity definitions to PostgreSQL-compatible types.

## Changes Made

### 1. DateTime Type Conversion
**Issue**: SQLite uses `datetime` type, but PostgreSQL uses `timestamp`

**Files Fixed**:
- `src/modules/transaction/entities/transaction.entity.ts`
  - Line 67: `reversedAt` field changed from `datetime` to `timestamp`

- `src/modules/transaction/entities/voucher.entity.ts`
  - Line 64: `authorizedAt` field changed from `datetime` to `timestamp`
  - Line 68: `cancelledAt` field changed from `datetime` to `timestamp`

### 2. Integer Type Conversion
**Issue**: SQLite uses `int` type, but PostgreSQL uses `integer`

**Files Fixed**:
- `src/modules/deposit/entities/recurring-deposit.entity.ts`
  - Line 33: `tenureMonths` changed from `int` to `integer`
  - Line 42: `installmentsPaid` changed from `int` to `integer`
  - Line 45: `installmentsMissed` changed from `int` to `integer`

- `src/modules/deposit/entities/fixed-deposit.entity.ts`
  - Line 33: `tenureMonths` changed from `int` to `integer`

- `src/modules/deposit/entities/rd-installment.entity.ts`
  - Line 21: `installmentNumber` changed from `int` to `integer`

- `src/modules/loan/entities/loan-account.entity.ts`
  - Line 39: `tenureMonths` changed from `int` to `integer`

## Type Mapping Reference

| SQLite Type | PostgreSQL Type | Usage |
|-------------|-----------------|-------|
| `datetime` | `timestamp` | Date and time with timezone |
| `int` | `integer` | Whole numbers |
| `real` | `double precision` | Floating point numbers |
| `text` | `text` | Variable length text |
| `varchar(n)` | `varchar(n)` | Fixed length text (compatible) |
| `decimal(p,s)` | `decimal(p,s)` | Exact numeric (compatible) |
| `date` | `date` | Date only (compatible) |
| `boolean` | `boolean` | True/false (compatible) |

## Verification Steps

1. **Check Entity Compilation**:
   ```bash
   cd backend
   npm run build
   ```

2. **Test Database Connection**:
   ```bash
   npm run start:dev
   ```

3. **Verify Schema Generation**:
   - Check that TypeORM can connect to PostgreSQL
   - Verify no "Data type not supported" errors
   - Confirm all entities are properly loaded

## Additional Notes

### Compatible Types (No Changes Needed)
The following TypeORM column types work with both SQLite and PostgreSQL:
- `date` - Date without time
- `text` - Variable length text
- `varchar(length)` - Variable character with length
- `decimal(precision, scale)` - Exact numeric
- `boolean` - Boolean values
- `simple-array` - Array stored as comma-separated string

### PostgreSQL-Specific Features Available
Now that we're using PostgreSQL, we can leverage:
- `jsonb` - Binary JSON with indexing
- `array` - Native array types
- `uuid` - Native UUID type
- `enum` - Native enum types
- `timestamp with time zone` - Timezone-aware timestamps
- Full-text search capabilities
- Advanced indexing options

## Testing Checklist

- [x] All entity files scanned for SQLite-specific types
- [x] `datetime` types converted to `timestamp`
- [x] `int` types converted to `integer`
- [x] No `real` types found (would need conversion to `double precision`)
- [x] Compatible types verified (date, text, varchar, decimal, boolean)
- [ ] Backend compilation successful
- [ ] Database connection successful
- [ ] All entities loaded without errors

## Next Steps

1. Start the backend server to verify all changes
2. Run database migrations if needed
3. Test CRUD operations on all entities
4. Monitor logs for any remaining type-related issues

## Rollback Instructions

If issues occur, the original SQLite-compatible types were:
- `timestamp` → `datetime`
- `integer` → `int`

However, these changes are necessary for PostgreSQL compatibility and should not be rolled back unless reverting to SQLite.

---

**Last Updated**: November 17, 2025  
**PostgreSQL Version**: 18.x  
**TypeORM Version**: Latest (as per package.json)
