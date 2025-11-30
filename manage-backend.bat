@echo off
REM =====================================================
REM Backend Server Management Script
REM =====================================================
REM Description: Interactive menu for backend management
REM Usage: Double-click this file or run from command line
REM =====================================================

title Loan Management - Backend Manager

:MENU
cls
echo.
echo ========================================
echo   BACKEND SERVER MANAGEMENT
echo ========================================
echo.
echo   1. Start Backend Server
echo   2. Stop Backend Server
echo   3. Restart Backend Server
echo   4. Check Server Status
echo   5. View Server Logs
echo   6. Install/Update Dependencies
echo   7. Run Database Migrations
echo   8. Test Database Connection
echo   9. Open API Documentation
echo   0. Exit
echo.
echo ========================================
echo.

set /p choice="Enter your choice (0-9): "

if "%choice%"=="1" goto START
if "%choice%"=="2" goto STOP
if "%choice%"=="3" goto RESTART
if "%choice%"=="4" goto STATUS
if "%choice%"=="5" goto LOGS
if "%choice%"=="6" goto INSTALL
if "%choice%"=="7" goto MIGRATE
if "%choice%"=="8" goto TESTDB
if "%choice%"=="9" goto DOCS
if "%choice%"=="0" goto EXIT

echo Invalid choice! Please try again.
timeout /t 2 >nul
goto MENU

:START
cls
echo.
echo ========================================
echo   STARTING BACKEND SERVER
echo ========================================
echo.
cd /d "%~dp0"
call start-backend.bat
goto MENU

:STOP
cls
echo.
echo ========================================
echo   STOPPING BACKEND SERVER
echo ========================================
echo.
cd /d "%~dp0"

REM Kill processes on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    echo Stopping process %%a...
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo [SUCCESS] Backend server stopped
echo.
pause
goto MENU

:RESTART
cls
echo.
echo ========================================
echo   RESTARTING BACKEND SERVER
echo ========================================
echo.
cd /d "%~dp0"
call restart-backend.bat
goto MENU

:STATUS
cls
echo.
echo ========================================
echo   SERVER STATUS CHECK
echo ========================================
echo.

REM Check if port 3000 is in use
netstat -ano | findstr :3000 | findstr LISTENING >nul 2>&1
if errorlevel 1 (
    echo [STATUS] Backend server is NOT running
    echo.
    echo Port 3000 is available
) else (
    echo [STATUS] Backend server is RUNNING
    echo.
    echo Processes on port 3000:
    netstat -ano | findstr :3000 | findstr LISTENING
    echo.
    echo Testing health endpoint...
    curl -s http://localhost:3000/api/v1/health
)

echo.
echo.
pause
goto MENU

:LOGS
cls
echo.
echo ========================================
echo   SERVER LOGS
echo ========================================
echo.
cd /d "%~dp0"

if exist "logs\combined.log" (
    echo [INFO] Displaying last 50 lines of combined.log:
    echo.
    powershell -Command "Get-Content logs\combined.log -Tail 50"
) else (
    echo [INFO] No log files found
)

echo.
echo.
pause
goto MENU

:INSTALL
cls
echo.
echo ========================================
echo   INSTALLING DEPENDENCIES
echo ========================================
echo.
cd /d "%~dp0"

echo [INFO] Installing npm packages...
echo.
call npm install

if errorlevel 1 (
    echo.
    echo [ERROR] Failed to install dependencies!
    pause
    goto MENU
)

echo.
echo [SUCCESS] Dependencies installed successfully!
echo.
pause
goto MENU

:MIGRATE
cls
echo.
echo ========================================
echo   DATABASE MIGRATIONS
echo ========================================
echo.
cd /d "%~dp0"

echo [INFO] Running database migrations...
echo.
call npm run migration:run

if errorlevel 1 (
    echo.
    echo [ERROR] Migration failed!
    echo Please check your database connection and try again.
    pause
    goto MENU
)

echo.
echo [SUCCESS] Migrations completed successfully!
echo.
pause
goto MENU

:TESTDB
cls
echo.
echo ========================================
echo   DATABASE CONNECTION TEST
echo ========================================
echo.
cd /d "%~dp0"

echo [INFO] Testing PostgreSQL connection...
echo.

REM Read database credentials from .env
for /f "tokens=1,2 delims==" %%a in ('findstr /r "^DB_" .env') do (
    if "%%a"=="DB_HOST" set DB_HOST=%%b
    if "%%a"=="DB_PORT" set DB_PORT=%%b
    if "%%a"=="DB_USERNAME" set DB_USER=%%b
    if "%%a"=="DB_DATABASE" set DB_NAME=%%b
)

echo Database: %DB_NAME%
echo Host: %DB_HOST%
echo Port: %DB_PORT%
echo User: %DB_USER%
echo.

REM Test connection using psql
where psql >nul 2>&1
if errorlevel 1 (
    echo [WARNING] psql command not found
    echo PostgreSQL client tools may not be installed
    echo.
    echo Testing via backend health endpoint instead...
    curl -s http://localhost:3000/api/v1/health
) else (
    echo Testing connection...
    psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d %DB_NAME% -c "SELECT version();"
)

echo.
echo.
pause
goto MENU

:DOCS
cls
echo.
echo ========================================
echo   OPENING API DOCUMENTATION
echo ========================================
echo.

REM Check if server is running
netstat -ano | findstr :3000 | findstr LISTENING >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Backend server is not running!
    echo.
    echo Please start the server first (Option 1)
    echo.
    pause
    goto MENU
)

echo [INFO] Opening API documentation in browser...
echo.
start http://localhost:3000/api/docs

timeout /t 2 >nul
goto MENU

:EXIT
cls
echo.
echo ========================================
echo   EXITING BACKEND MANAGER
echo ========================================
echo.

REM Ask if user wants to stop the server before exiting
netstat -ano | findstr :3000 | findstr LISTENING >nul 2>&1
if not errorlevel 1 (
    echo [WARNING] Backend server is still running!
    echo.
    set /p STOP_SERVER="Do you want to stop the server before exiting? (Y/N): "
    if /i "%STOP_SERVER%"=="Y" (
        echo.
        echo Stopping server...
        for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
            taskkill /F /PID %%a >nul 2>&1
        )
        echo [SUCCESS] Server stopped
        echo.
    )
)

echo.
echo Thank you for using Backend Manager!
echo.
timeout /t 2 >nul
exit
