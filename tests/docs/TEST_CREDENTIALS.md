# 🔑 Test Credentials

## Quick Reference - Login Credentials

### Test Users:

| Username | Password | Role | Status |
|----------|----------|------|--------|
| **admin** | **admin123** | Admin | ✅ Full Access |
| **manager** | **manager123** | Manager | ✅ Most Menus |
| **clerk** | **clerk123** | Clerk | ✅ Limited Access |

---

## 🚀 Quick Start

### 1. Check if users exist in database:

**Option A: Run batch file**
```bash
cd backend
check-users.bat
```

**Option B: Run in pgAdmin**
1. Open pgAdmin
2. Connect to `employeesociety_new` database
3. Open Query Tool
4. Open file: `backend/check-users.sql`
5. Execute (F5)

### 2. If no users found, insert test data:

**Option A: Run setup script**
```bash
cd backend
test-login-setup.bat
```

**Option B: Run in pgAdmin**
1. Open Query Tool
2. Open file: `backend/database/seeds/01-test-user-data.sql`
3. Execute (F5)

---

## 📊 Manual Database Queries

### Check if users exist:
```sql
SELECT userid, susername, userlevelid, enable_disable, login_status
FROM usermaster;
```

### Check user with role:
```sql
SELECT 
    u.userid,
    u.susername as username,
    ul.userlevel as role,
    u.enable_disable as status
FROM usermaster u
LEFT JOIN userlevelmaster ul ON u.userlevelid = ul.userlevelid;
```

### Insert test users manually:
```sql
-- Insert user levels first
INSERT INTO userlevelmaster (userlevelid, userlevel) 
VALUES 
    (1, 'Admin'),
    (2, 'Manager'),
    (3, 'Clerk')
ON CONFLICT (userlevelid) DO NOTHING;

-- Insert test users
INSERT INTO usermaster (susername, spassword, userlevelid, enable_disable, date_of_creation, login_status) 
VALUES 
    ('admin', 'admin123', 1, 'E', CURRENT_TIMESTAMP, 'N'),
    ('manager', 'manager123', 2, 'E', CURRENT_TIMESTAMP, 'N'),
    ('clerk', 'clerk123', 3, 'E', CURRENT_TIMESTAMP, 'N')
ON CONFLICT (susername) DO NOTHING;
```

---

## 🐛 Troubleshooting

### Issue: "Invalid credentials" error

**Check 1: Verify user exists**
```sql
SELECT * FROM usermaster WHERE susername = 'admin';
```

**Check 2: Verify user is enabled**
```sql
SELECT susername, enable_disable FROM usermaster WHERE susername = 'admin';
-- Should show: enable_disable = 'E'
```

**Check 3: Verify password**
- Password is stored as plain text: `admin123`
- Backend will hash it on first login

**Fix: Enable user if disabled**
```sql
UPDATE usermaster SET enable_disable = 'E' WHERE susername = 'admin';
```

### Issue: "User not found" error

**Solution: Insert test data**
```bash
cd backend
test-login-setup.bat
```

### Issue: Backend not connecting to database

**Check connection in .env file:**
```
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=Test@1212
DB_DATABASE=employeesociety_new
```

---

## 📝 Default Passwords

**All test users use simple passwords for testing:**
- Pattern: `{username}123`
- Examples:
  - admin → admin123
  - manager → manager123
  - clerk → clerk123

**⚠️ IMPORTANT:** Change these passwords in production!

---

## 🔍 Verify Login Flow

### Step 1: Check backend is running
```
Open: http://localhost:3000
Should see: {"message":"Loan Management System API","version":"1.0.0"}
```

### Step 2: Check frontend is running
```
Open: http://localhost:5177
Should see: Login page
```

### Step 3: Try login
```
Username: admin
Password: admin123
```

### Step 4: Check in database after login
```sql
-- Should show login_status = 'Y'
SELECT userid, susername, login_status FROM usermaster WHERE susername = 'admin';

-- Should show new login record
SELECT * FROM logintime WHERE userid = (SELECT userid FROM usermaster WHERE susername = 'admin')
ORDER BY login_date DESC LIMIT 1;
```

---

## 📞 Quick Help

**Can't login?**
1. Run `backend/check-users.bat` to see if users exist
2. If no users, run `backend/test-login-setup.bat`
3. Try login with: `admin` / `admin123`
4. Check backend console for errors

**Still not working?**
1. Check PostgreSQL is running
2. Check database name is correct: `employeesociety_new`
3. Check backend is running on port 3000
4. Check frontend is running on port 5177

---

**Last Updated:** November 2024  
**Default Username:** admin  
**Default Password:** admin123
