@echo off
REM =====================================================
REM Check Users in Database
REM =====================================================

title Check Users

cls
echo.
echo ========================================
echo   CHECKING USERS IN DATABASE
echo ========================================
echo.

cd /d "%~dp0"

echo Running query to check users...
echo.

psql -U postgres -d employeesociety_new -f check-users.sql

echo.
echo ========================================
echo   CHECK COMPLETE
echo ========================================
echo.
echo Press any key to exit...
pause >nul
