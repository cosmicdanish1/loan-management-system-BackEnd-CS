# Database Backup Troubleshooting Guide

## 🚨 **Current Issue: PostgreSQL Client Tools Not Found**

### **Error Message**
```
'psql' is not recognized as an internal or external command, operable program or batch file.
```

### **Root Cause**
The Database Backup component requires PostgreSQL client tools (`psql` and `pg_dump`) to be installed and available in the system PATH. These tools are not currently installed on your Windows system.

## ✅ **Immediate Solutions**

### **Solution 1: Install PostgreSQL (Recommended)**

#### **Quick Installation Steps**
1. **Download**: Go to https://www.postgresql.org/download/windows/
2. **Install**: Run installer as Administrator
3. **Important**: Check "Command Line Tools" during installation
4. **Add to PATH**: Add `C:\Program Files\PostgreSQL\15\bin` to system PATH
5. **Restart**: Restart your IDE/Command Prompt
6. **Test**: Run `psql --version` in Command Prompt

#### **Detailed PATH Setup**
1. Press `Win + R`, type `sysdm.cpl`, press Enter
2. Click "Environment Variables"
3. Under "System Variables", find and select "Path"
4. Click "Edit" → "New"
5. Add: `C:\Program Files\PostgreSQL\15\bin`
6. Click "OK" to save
7. Restart Command Prompt/IDE

### **Solution 2: Portable Installation**

If you can't install PostgreSQL system-wide:

1. **Download Binaries**: https://www.enterprisedb.com/download-postgresql-binaries
2. **Extract**: To `C:\PostgreSQL\bin`
3. **Add to PATH**: Add the bin folder to PATH
4. **Test**: Verify with `psql --version`

### **Solution 3: Temporary PATH (Quick Test)**

For immediate testing without permanent installation:

```cmd
# Windows Command Prompt
set PATH=%PATH%;C:\Program Files\PostgreSQL\15\bin
set PGPASSWORD=Test@1212
psql --version
```

```powershell
# PowerShell
$env:PATH += ";C:\Program Files\PostgreSQL\15\bin"
$env:PGPASSWORD = "Test@1212"
psql --version
```

## 🧪 **Verification Steps**

### **Step 1: Test PostgreSQL Tools**
```cmd
# Check if tools are available
psql --version
pg_dump --version

# Expected output:
# psql (PostgreSQL) 15.x
# pg_dump (PostgreSQL) 15.x
```

### **Step 2: Test Database Connection**
```cmd
# Set password
set PGPASSWORD=Test@1212

# Test connection
psql -h localhost -p 5432 -U postgres -d EMP_Espat_Society -c "SELECT version();"
```

### **Step 3: Test Backup Creation**
```cmd
# Create test backup
pg_dump -h localhost -p 5432 -U postgres --verbose --clean --if-exists --file=test_backup.sql EMP_Espat_Society
```

### **Step 4: Run Automated Test**
```cmd
cd backend
node test-backup.js
```

## 🔧 **Configuration Check**

### **Backend Environment (.env)**
Verify your `backend/.env` file has correct settings:

```env
# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=Test@1212
DB_DATABASE=EMP_Espat_Society

# Backup Configuration
BACKUP_PATH=./backups
BACKUP_RETENTION_DAYS=30
```

### **PostgreSQL Server Status**
Ensure PostgreSQL server is running:

```cmd
# Check service status
sc query postgresql-x64-15

# Start service if stopped
net start postgresql-x64-15
```

## 🐛 **Common Issues & Fixes**

### **Issue 1: PATH Not Updated**
```
Error: 'psql' is not recognized
```
**Fix**: 
- Restart Command Prompt after PATH changes
- Verify PATH includes PostgreSQL bin directory
- Use full path temporarily: `"C:\Program Files\PostgreSQL\15\bin\psql" --version`

### **Issue 2: PostgreSQL Server Not Running**
```
Error: could not connect to server: Connection refused
```
**Fix**:
- Start PostgreSQL service in Windows Services
- Check if PostgreSQL is installed and configured
- Verify port 5432 is not blocked by firewall

### **Issue 3: Authentication Failed**
```
Error: FATAL: password authentication failed for user "postgres"
```
**Fix**:
- Check password in `.env` file
- Reset PostgreSQL password if needed
- Verify username is correct

### **Issue 4: Database Not Found**
```
Error: FATAL: database "EMP_Espat_Society" does not exist
```
**Fix**:
- Create database using pgAdmin or psql
- Verify database name spelling in `.env`
- Check if database exists: `psql -U postgres -l`

### **Issue 5: Permission Denied**
```
Error: could not open file for writing: Permission denied
```
**Fix**:
- Choose different backup destination folder
- Run application as Administrator
- Check folder write permissions

## 🎯 **Quick Diagnostic Commands**

### **System Check**
```cmd
# Check Windows version
ver

# Check if PostgreSQL is installed
dir "C:\Program Files\PostgreSQL"

# Check PATH variable
echo %PATH%

# Check if ports are open
netstat -an | findstr :5432
```

### **PostgreSQL Check**
```cmd
# List PostgreSQL services
sc query | findstr postgres

# Check PostgreSQL version
psql --version
pg_dump --version

# List databases
set PGPASSWORD=Test@1212
psql -h localhost -U postgres -l
```

## 🔄 **Alternative Approaches**

### **Option 1: Docker PostgreSQL**
If installation continues to fail:

```cmd
# Install Docker Desktop
# Run PostgreSQL in container
docker run --name postgres -e POSTGRES_PASSWORD=Test@1212 -p 5432:5432 -d postgres:15

# Install only client tools separately
```

### **Option 2: WSL (Windows Subsystem for Linux)**
```bash
# Install WSL and Ubuntu
wsl --install

# In WSL, install PostgreSQL client
sudo apt update
sudo apt install postgresql-client

# Use WSL commands from Windows
wsl pg_dump --version
```

### **Option 3: Cloud Database**
- Use cloud PostgreSQL (AWS RDS, Azure, etc.)
- Install only client tools locally
- Connect to remote database

## 📊 **Success Indicators**

After successful setup, you should see:

### **Backend Logs**
```
[BackupService] Database connection successful
[BackupService] Starting database backup: EMP_Espat_Society_backup_2025_01_13_22_45_30.sql
[BackupService] Backup completed successfully: EMP_Espat_Society_backup_2025_01_13_22_45_30.sql (2.45 MB)
```

### **Frontend UI**
- 🟢 Green connection status indicator
- ✅ "Database Connection: Connected"
- 📊 Database info showing correct host/database
- 🎯 "Create Backup" button enabled

### **Test Script Output**
```
🧪 Testing PostgreSQL Backup Functionality...

0. Checking PostgreSQL client tools...
✅ psql available: psql (PostgreSQL) 15.x
✅ pg_dump available: pg_dump (PostgreSQL) 15.x

1. Testing database connection...
✅ Database connection successful

🎉 All tests passed! Backup functionality is working correctly.
```

## 📞 **Getting Help**

### **If Issues Persist**

1. **Check Logs**: Review backend console for detailed error messages
2. **Test Manually**: Use command line to test each step
3. **Verify Installation**: Ensure PostgreSQL installed correctly
4. **Check Permissions**: Run as Administrator if needed
5. **Network Issues**: Verify firewall/antivirus not blocking

### **Useful Resources**
- **PostgreSQL Documentation**: https://www.postgresql.org/docs/
- **Windows Installation Guide**: https://www.postgresql.org/download/windows/
- **pgAdmin Tool**: https://www.pgadmin.org/
- **Stack Overflow**: Search for specific error messages

## 🎉 **Expected Final State**

Once properly configured:

1. ✅ PostgreSQL client tools installed and in PATH
2. ✅ Database server running and accessible
3. ✅ Backend service connecting successfully
4. ✅ Frontend showing green connection status
5. ✅ Backup creation working through UI
6. ✅ Backup files being created in specified directory
7. ✅ Backup history showing created files

The Database Backup component will then provide full PostgreSQL backup functionality with a modern, user-friendly interface.