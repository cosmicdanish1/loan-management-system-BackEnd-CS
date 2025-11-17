@echo off
REM =====================================================
REM Backend Server Stop Script
REM =====================================================
REM Description: Stops the NestJS backend server
REM Usage: Double-click this file or run from command line
REM =====================================================

title Loan Management - Stop Backend

echo.
echo ========================================
echo   STOPPING BACKEND SERVER
echo ========================================
echo.

REM Change to backend directory
cd /d "%~dp0"

echo [INFO] Searching for backend processes...
echo.

REM Find and kill processes on port 3000
set "FOUND=0"
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    set "FOUND=1"
    echo Found backend process on port 3000 (PID: %%a)
    taskkill /F /PID %%a >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Failed to stop process %%a
    ) else (
        echo [SUCCESS] Stopped process %%a
    )
)

if "%FOUND%"=="0" (
    echo [INFO] No backend process found on port 3000
)

echo.
echo [INFO] Stopping all Node.js backend processes...

REM Kill node processes with backend window title
taskkill /F /IM node.exe /FI "WINDOWTITLE eq Loan Management - Backend Server" >nul 2>&1

echo.
echo ========================================
echo   BACKEND SERVER STOPPED
echo ========================================
echo.
echo Press any key to exit...
pause >nul
