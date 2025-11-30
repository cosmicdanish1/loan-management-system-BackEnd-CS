@echo off
REM Migration Script: SQLite to PostgreSQL (Windows)
REM This script helps migrate from SQLite to PostgreSQL

echo ==========================================
echo SQLite to PostgreSQL Migration Script
echo ==========================================
echo.

REM Check if PostgreSQL is installed
echo Checking PostgreSQL installation...
where psql >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] PostgreSQL is not installed!
    echo Please install PostgreSQL first. See POSTGRESQL_SETUP.md for instructions.
    pause
    exit /b 1
)
echo [OK] PostgreSQL is installed
echo.

REM Database configuration
set DB_NAME=loan_management_db
set DB_USER=postgres
set DB_HOST=localhost
set DB_PORT=5432

echo Database Configuration:
echo   Database: %DB_NAME%
echo   User: %DB_USER%
echo   Host: %DB_HOST%
echo   Port: %DB_PORT%
echo.

REM Prompt for password
set /p DB_PASSWORD="Please enter PostgreSQL password for user '%DB_USER%': "
echo.

REM Test connection
echo Testing PostgreSQL connection...
set PGPASSWORD=%DB_PASSWORD%
psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d postgres -c "SELECT 1" >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to connect to PostgreSQL!
    echo Please check your credentials and try again.
    pause
    exit /b 1
)
echo [OK] Successfully connected to PostgreSQL
echo.

REM Check if database exists
echo Checking if database '%DB_NAME%' exists...
psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='%DB_NAME%'" > temp_check.txt
set /p DB_EXISTS=<temp_check.txt
del temp_check.txt

if "%DB_EXISTS%"=="1" (
    echo [WARNING] Database '%DB_NAME%' already exists
    set /p RESPONSE="Do you want to drop and recreate it? (yes/no): "
    if /i "%RESPONSE%"=="yes" (
        echo Dropping existing database...
        psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d postgres -c "DROP DATABASE %DB_NAME%;"
        echo [OK] Database dropped
        set CREATE_DB=yes
    ) else (
        echo Using existing database...
        set CREATE_DB=no
    )
) else (
    set CREATE_DB=yes
)

REM Create database if needed
if "%CREATE_DB%"=="yes" (
    echo Creating database '%DB_NAME%'...
    psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d postgres -c "CREATE DATABASE %DB_NAME%;"
    echo [OK] Database created
)
echo.

REM Update .env file
echo Updating .env file...
(
echo # Application Configuration
echo NODE_ENV=development
echo PORT=3000
echo API_PREFIX=api/v1
echo.
echo # Database Configuration - PostgreSQL Only
echo DB_TYPE=postgres
echo DB_HOST=%DB_HOST%
echo DB_PORT=%DB_PORT%
echo DB_USERNAME=%DB_USER%
echo DB_PASSWORD=%DB_PASSWORD%
echo DB_DATABASE=%DB_NAME%
echo DB_SYNCHRONIZE=false
echo DB_LOGGING=true
echo.
echo # JWT Configuration
echo JWT_SECRET=your-super-secret-jwt-key-change-this-in-production-12345
echo JWT_EXPIRES_IN=24h
echo JWT_REFRESH_SECRET=your-super-secret-refresh-key-change-this-in-production-67890
echo JWT_REFRESH_EXPIRES_IN=7d
echo.
echo # Redis Configuration
echo REDIS_HOST=localhost
echo REDIS_PORT=6379
echo REDIS_PASSWORD=
echo.
echo # File Storage Configuration
echo FILE_STORAGE_PATH=./uploads
echo MAX_FILE_SIZE=5242880
echo ALLOWED_FILE_TYPES=jpg,jpeg,png,pdf
echo.
echo # Rate Limiting
echo THROTTLE_TTL=60
echo THROTTLE_LIMIT=100
echo.
echo # Logging Configuration
echo LOG_LEVEL=debug
echo LOG_FILE_PATH=./logs
echo.
echo # Email Configuration (Optional^)
echo SMTP_HOST=
echo SMTP_PORT=587
echo SMTP_USER=
echo SMTP_PASS=
echo SMTP_FROM=noreply@loanmanagement.com
echo.
echo # Backup Configuration
echo BACKUP_PATH=./backups
echo BACKUP_RETENTION_DAYS=30
) > ..\.env
echo [OK] .env file updated
echo.

REM Remove SQLite database file
if exist "..\loan_management.db" (
    set /p REMOVE_SQLITE="Found SQLite database file. Do you want to back it up? (yes/no): "
    if /i "%REMOVE_SQLITE%"=="yes" (
        move "..\loan_management.db" "..\loan_management.db.backup"
        echo [OK] SQLite database backed up to loan_management.db.backup
    )
)
echo.

REM Install/Update dependencies
echo Installing dependencies...
cd ..
call npm install
echo [OK] Dependencies installed
echo.

REM Run migrations
echo Running database migrations...
call npm run migration:run
echo [OK] Migrations completed
echo.

echo ==========================================
echo [SUCCESS] Migration to PostgreSQL completed!
echo ==========================================
echo.
echo Next steps:
echo 1. Review the .env file and update any necessary configurations
echo 2. Start your application: npm run start:dev
echo 3. Verify the database connection
echo.
echo For more information, see POSTGRESQL_SETUP.md
echo.
pause
