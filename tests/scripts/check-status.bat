@echo off
REM =====================================================
REM Backend Server Status Check
REM =====================================================
REM Quick status check for backend server
REM =====================================================

title Backend Status Check

cls
echo.
echo ========================================
echo   BACKEND SERVER STATUS CHECK
echo ========================================
echo.

cd /d "%~dp0"

REM Check if backend is running on port 3000
echo [1/4] Checking if backend is running...
netstat -ano | findstr :3000 | findstr LISTENING >nul 2>&1
if errorlevel 1 (
    echo [STATUS] ❌ Backend is NOT running
    set BACKEND_RUNNING=NO
) else (
    echo [STATUS] ✅ Backend is RUNNING
    set BACKEND_RUNNING=YES
    
    REM Get PID
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
        echo [INFO] Process ID: %%a
    )
)
echo.

REM Check if PostgreSQL is accessible
echo [2/4] Checking PostgreSQL connection...
where psql >nul 2>&1
if errorlevel 1 (
    echo [STATUS] ⚠️  PostgreSQL client not found in PATH
) else (
    echo [STATUS] ✅ PostgreSQL client available
)
echo.

REM Test health endpoint if backend is running
if "%BACKEND_RUNNING%"=="YES" (
    echo [3/4] Testing health endpoint...
    curl -s http://localhost:3000/api/v1/health
    echo.
    echo.
) else (
    echo [3/4] Skipping health check (backend not running)
    echo.
)

REM Check .env file
echo [4/4] Checking configuration...
if exist ".env" (
    echo [STATUS] ✅ .env file exists
    
    REM Display database config
    echo.
    echo Database Configuration:
    findstr /r "^DB_" .env
) else (
    echo [STATUS] ❌ .env file NOT found
)

echo.
echo ========================================
echo   STATUS CHECK COMPLETE
echo ========================================
echo.

if "%BACKEND_RUNNING%"=="YES" (
    echo ✅ Backend is running and ready
    echo.
    echo Available URLs:
    echo   - API: http://localhost:3000/api/v1
    echo   - Docs: http://localhost:3000/api/docs
    echo   - Health: http://localhost:3000/api/v1/health
) else (
    echo ❌ Backend is not running
    echo.
    echo To start backend, run: start-backend.bat
)

echo.
pause
