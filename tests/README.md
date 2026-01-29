# Test Scripts for Day-book SB Functionality

This folder contains test scripts for debugging and testing the Day-book SB (Savings Bank) functionality.

## Test Scripts

### 1. `test-daybook-sb-api.js`
**Purpose**: Tests the Day-book SB API endpoints to ensure they work correctly.

**Features**:
- Tests regular daybook endpoint
- Tests SB-specific endpoint (`/daybook/report/sb`)
- Tests filterType parameter
- Verifies SB filtering is working correctly
- Checks if SB entries only contain savings-related codes

**Usage**:
```bash
cd backend
node test/test-daybook-sb-api.js
```

**Requirements**: 
- Backend server must be running on localhost:3000
- axios package (install with `npm install axios` if not available)

### 2. `debug-daybook-query.js`
**Purpose**: Debug script to test daybook database queries directly.

**Features**:
- Tests the exact SQL query used by the daybook service
- Shows raw database results
- Tests money data type parsing
- Compares SB filtered vs regular queries

**Usage**:
```bash
cd backend
node test/debug-daybook-query.js
```

**Requirements**: 
- PostgreSQL database connection
- pg package (should be available from backend dependencies)

### 3. `check-transactions-detailed.js`
**Purpose**: Provides comprehensive transaction data analysis for debugging.

**Features**:
- Shows recent transactions with full details
- Checks member_master for member names
- Checks headmaster for head names
- Analyzes transaction types and amounts
- Shows savings-related transactions (A codes)

**Usage**:
```bash
cd backend
node test/check-transactions-detailed.js
```

**Requirements**: 
- PostgreSQL database connection
- pg package (should be available from backend dependencies)

## Database Configuration

All test scripts use the following database configuration:
```javascript
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'loan_management',
  user: 'postgres',
  password: 'admin123'
});
```

Update the configuration in each script if your database settings are different.

## Test Data

To ensure proper testing, make sure you have sample transaction data. You can populate test data using:
```bash
cd backend
node populate-sample-transactions.js
```

## Expected Results

### SB Filtering
The SB (Savings Bank) functionality should:
- Filter transactions to show only savings-related entries
- Include transactions with codes starting with 'A' (A1001, A1002, A1003, etc.)
- Show fewer or equal transactions compared to regular daybook
- Calculate correct totals for receipts, payments, and balances

### API Responses
All API endpoints should return:
- Status code 200
- Success: true
- Proper data structure with entries, totals, and balances
- Correct money amount parsing (no zero amounts)

## Troubleshooting

### Common Issues

1. **Zero amounts in API response**:
   - Check money data type parsing in `parseMoneyAmount` function
   - Verify database query is returning correct data types

2. **No transactions found**:
   - Check if sample data exists for the test date
   - Verify database connection and table structure

3. **SB filtering not working**:
   - Check if headmaster table has correct head names
   - Verify filtering logic in daybook service

4. **Member names showing as "Unknown"**:
   - Check member_master table has data
   - Verify mbno data type matching between tables

## Future Enhancements

These test scripts can be extended to:
- Add automated test assertions
- Include performance testing
- Test different date ranges
- Test error scenarios
- Add integration with testing frameworks like Jest

## Last Updated
December 17, 2025 - Initial creation with Day-book SB implementation