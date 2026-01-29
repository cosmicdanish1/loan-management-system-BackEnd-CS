# Database Backup Troubleshooting Guide

## 🚨 **Current Issues & Solutions**

### **Issue 1: 404 Errors - Backup Endpoints Not Found**

**Error Messages:**
```
Cannot GET /api/v1/backup/test-connection
Cannot GET /api/v1/backup/database-info  
Cannot GET /api/v1/backup/list
```

**Root Cause:** The BackupModule is not being loaded by the NestJS application.

**Solutions:**

#### **1. Restart Backend Server (Most Common Fix)**
```bash
cd backend
npm run start:dev
```

#### **2. Verify Module Registration**
Check that `BackupModule` is properly imported in `backend/src/app.module.ts`:
```typescript
import { BackupModule } from './modules/backup/backup.module';

@Module({
  imports: [
    // ... other modules
    BackupModule,  // ← Should be here
  ],
})
```

#### **3. Check for Compilation Errors**
Look for TypeScript compilation errors in the terminal:
```bash
# Should show no errors
npm run build
```

#### **4. Verify Module Files Exist**
Ensure all backup module files are present:
```
backend/src/modules/backup/
├── backup.module.ts
├── backup.service.ts
└── backup.controller.ts
```

### **Issue 2: TypeScript Compilation Error**

**Error Message:**
```
Cannot find module 'date-fns' or its corresponding type declarations
```

**Solution:** The `date-fns` import has been removed. If you still see this error:

1. **Clear TypeScript Cache:**
```bash
cd backend
rm -rf dist/
rm -rf node_modules/.cache/
npm run build
```

2. **Restart IDE/Editor:** Close and reopen your code editor

3. **Check for Stale Imports:** Search for any remaining `date-fns` references:
```bash
grep -r "date-fns" backend/src/modules/backup/
```

## 🧪 **Testing & Verification**

### **1. Run Verification Script**
```bash
cd backend
node verify-backup-module.js
```

### **2. Test PostgreSQL Connection**
```bash
cd backend  
node test-backup.js
```

### **3. Manual API Testing**
```bash
# Test if endpoints are available
curl http://localhost:3000/api/v1/backup/test-connection
curl http://localhost:3000/api/v1/backup/database-info
```

## 🔧 **Step-by-Step Fix Process**

### **Step 1: Stop Backend Server**
```bash
# Press Ctrl+C in the terminal running the backend
```

### **Step 2: Clean Build**
```bash
cd backend
rm -rf dist/
npm run build
```

### **Step 3: Restart Backend**
```bash
npm run start:dev
```

### **Step 4: Verify Module Loading**
Look for these messages in the terminal:
```
[Nest] BackupModule dependencies initialized
[Nest] BackupController {/backup}:
[Nest] Mapped {/backup/create, POST} route
[Nest] Mapped {/backup/test-connection, GET} route
[Nest] Mapped {/backup/database-info, GET} route
[Nest] Mapped {/backup/list, GET} route
```

### **Step 5: Test Frontend**
1. Open Database Backup utility
2. Check connection status (should show green or red, not yellow)
3. Try creating a backup

## 🐛 **Common Issues & Quick Fixes**

### **Module Not Loading**
```bash
# 1. Check imports
grep -n "BackupModule" backend/src/app.module.ts

# 2. Verify file exists  
ls -la backend/src/modules/backup/backup.module.ts

# 3. Check for syntax errors
npm run lint
```

### **PostgreSQL Connection Issues**
```bash
# Test PostgreSQL directly
psql -h localhost -p 5432 -U postgres -d EMP_Espat_Society

# Check if pg_dump is available
pg_dump --version
```

### **File Permission Issues**
```bash
# Test backup directory creation
mkdir -p C:/DatabaseBackups
echo "test" > C:/DatabaseBackups/test.txt
rm C:/DatabaseBackups/test.txt
```

## 📋 **Verification Checklist**

- [ ] Backend server restarted
- [ ] No TypeScript compilation errors
- [ ] BackupModule imported in app.module.ts
- [ ] All backup module files exist
- [ ] PostgreSQL server running
- [ ] pg_dump utility available
- [ ] Backup endpoints return 200/401 (not 404)
- [ ] Frontend shows connection status

## 🎯 **Expected Behavior After Fix**

### **Backend Terminal Should Show:**
```
[Nest] BackupModule dependencies initialized
[Nest] BackupController {/backup}:
[Nest] Mapped {/backup/create, POST} route
[Nest] Mapped {/backup/test-connection, GET} route
```

### **Frontend Should Show:**
- Connection status indicator (green/red, not yellow)
- Database information in status cards
- No "Backup service not available" errors

### **API Endpoints Should Return:**
- `GET /api/v1/backup/test-connection` → 200 or 401 (not 404)
- `GET /api/v1/backup/database-info` → 200 or 401 (not 404)
- `GET /api/v1/backup/list` → 200 or 401 (not 404)

## 🆘 **If Issues Persist**

1. **Check Backend Logs:** Look for detailed error messages in the terminal
2. **Verify Environment:** Ensure all environment variables are set correctly
3. **Test PostgreSQL:** Verify database connection works outside the application
4. **Clean Install:** Delete `node_modules` and reinstall dependencies

```bash
cd backend
rm -rf node_modules package-lock.json
npm install
npm run start:dev
```

The backup functionality should work correctly once the module is properly loaded and the backend server is restarted.