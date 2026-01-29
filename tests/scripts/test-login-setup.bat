@echo off
REM =====================================================
REM Quick Login Testing Setup Script
REM =====================================================

title Login Testing Setup

cls
echo.
echo ========================================
echo   LOGIN TESTING SETUP
echo ========================================
echo.

cd /d "%~dp0"

echo [STEP 1/3] Inserting test data into database...
echo.

psql -U postgres -d employeesociety_new -f database/seeds/01-test-user-data.sql

if errorlevel 1 (
    echo.
    echo [ERROR] Failed to insert test data
    echo.
    echo Please check:
    echo - PostgreSQL is running
    echo - Database 'employeesociety_new' exists
    echo - Password is correct (Test@1212)
    echo.
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Test data inserted successfully!
echo.

echo [STEP 2/3] Test Users Created:
echo.
echo Username: admin     Password: admin123     Role: Admin
echo Username: manager   Password: manager123   Role: Manager  
echo Username: clerk     Password: clerk123     Role: Clerk
echo.

echo [STEP 3/3] Next Steps:
echo.
echo 1. Start backend:  npm run start:dev
echo 2. Start frontend: cd Frontend && npm run dev
echo 3. Open browser:   http://localhost:5177/login
echo 4. Login with:     admin / admin123
echo.

echo ========================================
echo   SETUP COMPLETE!
echo ========================================
echo.
echo Press any key to exit...
pause >nul
