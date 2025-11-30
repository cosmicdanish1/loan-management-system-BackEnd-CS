# 🧪 Testing Login Guide

Complete guide to test the login functionality from frontend and verify data in database.

## 📋 Prerequisites

1. ✅ Backend server running on port 3000
2. ✅ Frontend server running on port 5177
3. ✅ PostgreSQL database `employeesociety_new` accessible
4. ✅ pgAdmin or psql installed

---

## 🚀 Step-by-Step Testing Process

### Step 1: Insert Test Data into Database

**Option A: Using pgAdmin**
1. Open pgAdmin
2. Connect to your PostgreSQL server
3. Navigate to: `Servers` → `PostgreSQL 18` → `Databases` → `employeesociety_new`
4. Right-click on `employeesociety_new` → `Query Tool`
5. Open file: `backend/database/seeds/01-test-user-data.sql`
6. Click `Execute` (F5)
7. Verify output shows test users created

**Option B: Using Command Line**
```bash
psql -U postgres -d employeesociety_new -f backend/database/seeds/01-test-user-data.sql
```

### Step 2: Verify Test Data in Database

Run these queries in pgAdmin Query Tool:

```sql
-- Check user levels
SELECT * FROM userlevelmaster;

-- Check test users
SELECT userid, susername, userlevelid, enable_disable, login_status 
FROM usermaster;

-- Check menus
SELECT * FROM menumaster;

-- Check default permissions
SELECT uld.*, ul.userlevel, m.menuname 
FROM userleveldefaultrights uld
JOIN userlevelmaster ul ON uld.userlevelid = ul.userlevelid
JOIN menumaster m ON uld.menuid = m.menuid
ORDER BY uld.userlevelid;
```

**Expected Results:**
- 3 user levels: Admin, Manager, Clerk
- 3 test users: admin, manager, clerk
- 5 menu items: Dashboard, Masters, Transactions, Reports, Administration
- Default permissions assigned to each role

---

### Step 3: Start Backend Server

```bash
cd backend
npm run start:dev
```

**Verify Backend is Running:**
- Open browser: http://localhost:3000
- Should see: `{"message":"Loan Management System API","version":"1.0.0"}`

---

### Step 4: Start Frontend Application

```bash
cd Frontend
npm run dev
```

**Verify Frontend is Running:**
- Open browser: http://localhost:5177
- Should see login page

---

### Step 5: Test Login from Frontend

**Test User Credentials:**

| Username | Password | Role | Access Level |
|----------|----------|------|--------------|
| admin | admin123 | Admin | Full access (all menus) |
| manager | manager123 | Manager | Most menus (no Administration) |
| clerk | clerk123 | Clerk | Limited access (Dashboard, Masters, Transactions) |

**Login Steps:**
1. Open http://localhost:5177/login
2. Enter username: `admin`
3. Enter password: `admin123`
4. Click "Sign In"
5. Should redirect to dashboard

---

### Step 6: Verify Login Data in Database

After successful login, run these queries in pgAdmin:

**1. Check Login Status Updated:**
```sql
SELECT userid, susername, login_status, enable_disable
FROM usermaster
WHERE susername = 'admin';
```
Expected: `login_status` should be 'Y'

**2. Check Login Time Record Created:**
```sql
SELECT * FROM logintime
WHERE userid = (SELECT userid FROM usermaster WHERE susername = 'admin')
ORDER BY login_date DESC
LIMIT 1;
```
Expected: New record with today's date, login_time filled, logout_time empty

**3. Check User Info Updated:**
```sql
SELECT * FROM userinfo
WHERE userid = (SELECT userid FROM usermaster WHERE susername = 'admin');
```
Expected: Record with hostname and abnormal_status = 'N'

**4. View Complete Login Session:**
```sql
SELECT 
    u.userid,
    u.susername,
    ul.userlevel,
    u.login_status,
    lt.login_date,
    lt.login_time,
    lt.logout_time,
    ui.hostname,
    ui.abnormal_status
FROM usermaster u
LEFT JOIN userlevelmaster ul ON u.userlevelid = ul.userlevelid
LEFT JOIN logintime lt ON u.userid = lt.userid
LEFT JOIN userinfo ui ON u.userid = ui.userid
WHERE u.susername = 'admin'
ORDER BY lt.login_date DESC
LIMIT 1;
```

---

### Step 7: Test Logout

**Logout Steps:**
1. Click logout button in frontend
2. Should redirect to login page

**Verify Logout in Database:**
```sql
SELECT * FROM logintime
WHERE userid = (SELECT userid FROM usermaster WHERE susername = 'admin')
ORDER BY login_date DESC
LIMIT 1;
```
Expected: `logout_time` should now be filled

```sql
SELECT userid, susername, login_status
FROM usermaster
WHERE susername = 'admin';
```
Expected: `login_status` should be 'N'

---

### Step 8: Test Session Management (One Login Per Day)

**Test Steps:**
1. Login with `admin` / `admin123`
2. Without logging out, try to login again in another browser/tab
3. Should see error: "User already has an active session today"

**Verify in Database:**
```sql
-- Check for active sessions (empty logout_time)
SELECT 
    u.susername,
    lt.login_date,
    lt.login_time,
    lt.logout_time,
    CASE 
        WHEN lt.logout_time = '' THEN 'ACTIVE'
        ELSE 'CLOSED'
    END as session_status
FROM logintime lt
JOIN usermaster u ON lt.userid = u.userid
WHERE DATE(lt.login_date) = CURRENT_DATE
ORDER BY lt.login_date DESC;
```

---

## 🔍 Monitoring Queries

### View All Active Sessions:
```sql
SELECT 
    u.userid,
    u.susername,
    ul.userlevel,
    lt.login_date,
    lt.login_time,
    ui.hostname
FROM logintime lt
JOIN usermaster u ON lt.userid = u.userid
JOIN userlevelmaster ul ON u.userlevelid = ul.userlevelid
LEFT JOIN userinfo ui ON u.userid = ui.userid
WHERE lt.logout_time = ''
ORDER BY lt.login_date DESC;
```

### View Login History (Last 10 logins):
```sql
SELECT 
    u.susername,
    lt.login_date,
    lt.login_time,
    lt.logout_time,
    CASE 
        WHEN lt.logout_time = '' THEN 'Active'
        ELSE 'Closed'
    END as status,
    ui.hostname
FROM logintime lt
JOIN usermaster u ON lt.userid = u.userid
LEFT JOIN userinfo ui ON u.userid = ui.userid
ORDER BY lt.login_date DESC
LIMIT 10;
```

### View User Permissions:
```sql
-- User-specific permissions
SELECT 
    u.susername,
    m.menuname,
    m.menudesc
FROM userrights ur
JOIN usermaster u ON ur.userid = u.userid
JOIN menumaster m ON ur.menuid = m.menuid
WHERE u.susername = 'admin';

-- Default role permissions
SELECT 
    ul.userlevel,
    m.menuname,
    m.menudesc
FROM userleveldefaultrights uld
JOIN userlevelmaster ul ON uld.userlevelid = ul.userlevelid
JOIN menumaster m ON uld.menuid = m.menuid
WHERE ul.userlevel = 'Admin'
ORDER BY m.menuid;
```

---

## 🐛 Troubleshooting

### Issue 1: "Cannot connect to database"
**Solution:**
```bash
# Check PostgreSQL is running
sc query postgresql-x64-18

# Check connection in .env file
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=Test@1212
DB_DATABASE=employeesociety_new
```

### Issue 2: "Invalid credentials"
**Solution:**
- Verify test data was inserted: `SELECT * FROM usermaster;`
- Check password is correct: `admin123`
- Ensure user is enabled: `enable_disable = 'E'`

### Issue 3: "User account is disabled"
**Solution:**
```sql
UPDATE usermaster 
SET enable_disable = 'E' 
WHERE susername = 'admin';
```

### Issue 4: Backend not starting
**Solution:**
```bash
# Check for errors
cd backend
npm run start:dev

# Check if entities are loaded
# Look for: "TypeOrmModule dependencies initialized"
```

### Issue 5: Frontend not connecting to backend
**Solution:**
- Check API_BASE_URL in `Frontend/src/services/api.ts`
- Should be: `http://localhost:3000/api/v1`
- Check CORS is enabled in backend

---

## ✅ Success Checklist

After testing, you should have:

- [x] Test users created in database
- [x] Successful login from frontend
- [x] Login status updated to 'Y' in usermaster
- [x] Login time record created in logintime table
- [x] User info updated in userinfo table
- [x] Successful logout
- [x] Logout time recorded in logintime table
- [x] Login status updated to 'N' in usermaster
- [x] Session management working (one login per day)

---

## 📊 Database Schema Reference

```
usermaster (Main user table)
    ↓
userlevelmaster (User roles)
    ↓
userleveldefaultrights (Default permissions per role)
    ↓
menumaster (Available menus)
    ↓
userrights (User-specific permissions)
    ↓
logintime (Session tracking)
    ↓
userinfo (Login metadata)
```

---

## 🎯 Next Steps

After successful testing:
1. Add more test users with different roles
2. Test permission-based menu filtering
3. Test force logout functionality
4. Test session expiry
5. Test abnormal login detection
6. Add audit logging

---

**Last Updated:** November 2024  
**Database:** PostgreSQL 18.x  
**Backend:** NestJS + TypeORM  
**Frontend:** React + TypeScript
