@echo off
REM =====================================================
REM Backend Server Restart Script
REM =====================================================
REM Description: Stops and restarts the NestJS backend server
REM Usage: Double-click this file or run from command line
REM =====================================================

title Loan Management - Backend Restart

echo.
echo ========================================
echo   RESTARTING BACKEND SERVER
echo ========================================
echo.

REM Change to backend directory
cd /d "%~dp0"

echo [STEP 1/3] Stopping existing backend processes...
echo.

REM Kill any existing Node.js processes running on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    echo Found process on port 3000 (PID: %%a)
    taskkill /F /PID %%a >nul 2>&1
    if errorlevel 1 (
        echo [WARNING] Could not kill process %%a
    ) else (
        echo [SUCCESS] Stopped process %%a
    )
)

REM Also kill any node.exe processes in backend directory
echo.
echo Stopping all Node.js processes...
taskkill /F /IM node.exe /FI "WINDOWTITLE eq Loan Management - Backend Server" >nul 2>&1

REM Wait a moment for processes to fully terminate
timeout /t 2 /nobreak >nul

echo.
echo [STEP 2/3] Clearing cache and temporary files...
echo.

REM Clear npm cache (optional)
REM call npm cache clean --force

REM Remove dist folder if exists
if exist "dist\" (
    echo Removing old build files...
    rmdir /s /q dist
    echo [SUCCESS] Build files cleared
)

echo.
echo [STEP 3/3] Starting backend server...
echo.

REM Start the backend server
call start-backend.bat

REM If start-backend.bat doesn't exist, start directly
if errorlevel 1 (
    echo.
    echo [INFO] Starting server directly...
    echo.
    call npm run start:dev
)
