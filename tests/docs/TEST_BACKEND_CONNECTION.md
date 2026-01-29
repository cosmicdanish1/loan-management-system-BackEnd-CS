# Backend Connection Test

## Issue: "Failed to fetch"

This error means the frontend cannot connect to the backend API.

## Possible Causes:

1. **Backend is not running** ❌
2. **Wrong port** (should be 3001)
3. **CORS not configured**
4. **Firewall blocking**

## Solution:

### 1. Start Backend Server

```bash
cd backend
npm run start:dev
```

**Wait for this message:**
```
[Nest] Application successfully started
Listening on port 3001
```

### 2. Verify Backend is Running

Open browser and go to:
```
http://localhost:3001/api/v1/members/lookup
```

You should see JSON data (member list).

### 3. Test Loan Application Endpoint

```bash
# Windows PowerShell
Invoke-WebRequest -Uri "http://localhost:3001/api/v1/members/generate/loan-case-number" -Method GET
```

Should return:
```json
{"loanCaseNo":"10001"}
```

### 4. Check Backend Logs

When you click Save in the frontend, you should see in backend console:
```
Received loan application data: {
  "memberNo": "30017091",
  "loanType": "EMERGENCY LOAN",
  ...
}
```

## Current Status:

❌ Backend is NOT running
✅ Frontend is running

## Action Required:

**START THE BACKEND SERVER!**

```bash
cd F:\company\main project\backend
npm run start:dev
```

Then try saving the loan application again.
