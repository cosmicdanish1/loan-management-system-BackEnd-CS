# 🔌 Frontend-Backend Connection Test

## Quick Connection Test Guide

### Prerequisites
- ✅ PostgreSQL database running
- ✅ Database `loan_management_db` created
- ✅ `.env` file configured with correct credentials

---

## Step 1: Start Backend Server

```bash
cd backend
npm install
npm run start:dev
```

**Expected Output:**
```
🚀 Application is running on: http://localhost:3000
📚 Swagger documentation: http://localhost:3000/api/docs
```

---

## Step 2: Test Backend Health Endpoint

Open a new terminal and run:

```bash
curl http://localhost:3000/api/v1/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "2024-11-17T..."
}
```

Or open in browser: http://localhost:3000/api/v1/health

---

## Step 3: Check Swagger Documentation

Open in browser: http://localhost:3000/api/docs

You should see the API documentation interface.

---

## Step 4: Start Frontend Application

Open a new terminal:

```bash
cd Frontend
npm install
npm run dev
```

**Expected Output:**
```
VITE v5.x.x  ready in xxx ms
➜  Local:   http://localhost:5177/
```

---

## Step 5: Test Frontend-Backend Communication

### Option A: Using Browser Console

1. Open the frontend: http://localhost:5177
2. Open Browser DevTools (F12)
3. Go to Console tab
4. Run this command:

```javascript
fetch('http://localhost:3000/api/v1/health')
  .then(res => res.json())
  .then(data => console.log('✅ Backend Connected:', data))
  .catch(err => console.error('❌ Connection Failed:', err));
```

**Expected Output:**
```
✅ Backend Connected: {status: "ok", database: "connected", ...}
```

### Option B: Using Frontend API Service

Create a test file: `Frontend/src/test-connection.ts`

```typescript
import { apiService } from './services/api';

async function testConnection() {
  try {
    const response = await fetch('http://localhost:3000/api/v1/health');
    const data = await response.json();
    console.log('✅ Backend Connection Successful:', data);
    return true;
  } catch (error) {
    console.error('❌ Backend Connection Failed:', error);
    return false;
  }
}

testConnection();
```

---

## Step 6: Verify Database Connection

### Check Backend Logs

In the backend terminal, you should see:
```
[Nest] INFO [TypeOrmModule] Database connected successfully
```

### Test Database Query

```bash
# Connect to PostgreSQL
psql -U postgres -d loan_management_db

# Run a test query
SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';

# Exit
\q
```

---

## 🔍 Troubleshooting

### Issue 1: Backend Won't Start

**Error:** `ECONNREFUSED` or database connection error

**Solution:**
1. Check if PostgreSQL is running:
   ```bash
   # Windows
   sc query postgresql-x64-15
   
   # Linux/Mac
   sudo systemctl status postgresql
   ```

2. Verify `.env` configuration:
   ```bash
   cd backend
   cat .env
   ```

3. Test database connection:
   ```bash
   psql -U postgres -d loan_management_db -c "SELECT 1;"
   ```

### Issue 2: CORS Error in Frontend

**Error:** `Access to fetch at 'http://localhost:3000' from origin 'http://localhost:5177' has been blocked by CORS`

**Solution:**
Backend `main.ts` already has CORS enabled for `http://localhost:5177`. If still having issues:

1. Check backend logs for CORS errors
2. Verify frontend is running on port 5177
3. Restart backend server

### Issue 3: Port Already in Use

**Error:** `Port 3000 is already in use`

**Solution:**
```bash
# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# Linux/Mac
lsof -ti:3000 | xargs kill -9
```

### Issue 4: Frontend Can't Connect

**Error:** `Failed to fetch` or `Network Error`

**Solution:**
1. Verify backend is running: http://localhost:3000/api/v1/health
2. Check browser console for errors
3. Verify API_BASE_URL in `Frontend/src/services/api.ts`:
   ```typescript
   const API_BASE_URL = 'http://localhost:3000/api/v1';
   ```

---

## ✅ Connection Checklist

- [ ] PostgreSQL is running
- [ ] Database `loan_management_db` exists
- [ ] Backend `.env` file is configured
- [ ] Backend starts without errors (port 3000)
- [ ] Health endpoint responds: http://localhost:3000/api/v1/health
- [ ] Swagger docs accessible: http://localhost:3000/api/docs
- [ ] Frontend starts without errors (port 5177)
- [ ] Frontend can fetch from backend (no CORS errors)
- [ ] Browser console shows no connection errors

---

## 📊 Current Configuration

### Backend:
- **URL**: http://localhost:3000
- **API Prefix**: /api/v1
- **Database**: PostgreSQL (loan_management_db)
- **CORS**: Enabled for http://localhost:5177

### Frontend:
- **URL**: http://localhost:5177
- **API Base**: http://localhost:3000/api/v1
- **Framework**: React + Vite + Electron

---

## 🚀 Next Steps After Connection Verified

Once connection is confirmed:

1. ✅ Test authentication endpoints
2. ✅ Test member CRUD operations
3. ✅ Test account management
4. ✅ Test transaction processing
5. ✅ Implement remaining features

---

## 📝 Quick Test Script

Save this as `test-connection.js` in the root directory:

```javascript
const http = require('http');

function testBackend() {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:3000/api/v1/health', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('✅ Backend Response:', data);
        resolve(JSON.parse(data));
      });
    }).on('error', (err) => {
      console.error('❌ Backend Connection Failed:', err.message);
      reject(err);
    });
  });
}

testBackend()
  .then(() => console.log('\n✅ Connection Test PASSED'))
  .catch(() => console.log('\n❌ Connection Test FAILED'));
```

Run with:
```bash
node test-connection.js
```

---

**Last Updated**: November 2024  
**Status**: Ready for Testing
