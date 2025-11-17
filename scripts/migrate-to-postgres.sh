#!/bin/bash

# Migration Script: SQLite to PostgreSQL
# This script helps migrate from SQLite to PostgreSQL

echo "=========================================="
echo "SQLite to PostgreSQL Migration Script"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if PostgreSQL is installed
echo "Checking PostgreSQL installation..."
if ! command -v psql &> /dev/null; then
    echo -e "${RED}❌ PostgreSQL is not installed!${NC}"
    echo "Please install PostgreSQL first. See POSTGRESQL_SETUP.md for instructions."
    exit 1
fi
echo -e "${GREEN}✅ PostgreSQL is installed${NC}"
echo ""

# Check if PostgreSQL is running
echo "Checking if PostgreSQL is running..."
if ! pg_isready &> /dev/null; then
    echo -e "${RED}❌ PostgreSQL is not running!${NC}"
    echo "Please start PostgreSQL service first."
    exit 1
fi
echo -e "${GREEN}✅ PostgreSQL is running${NC}"
echo ""

# Database configuration
DB_NAME="loan_management_db"
DB_USER="postgres"
DB_HOST="localhost"
DB_PORT="5432"

echo "Database Configuration:"
echo "  Database: $DB_NAME"
echo "  User: $DB_USER"
echo "  Host: $DB_HOST"
echo "  Port: $DB_PORT"
echo ""

# Prompt for password
echo -e "${YELLOW}Please enter PostgreSQL password for user '$DB_USER':${NC}"
read -s DB_PASSWORD
echo ""

# Test connection
echo "Testing PostgreSQL connection..."
export PGPASSWORD=$DB_PASSWORD
if ! psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d postgres -c "SELECT 1" &> /dev/null; then
    echo -e "${RED}❌ Failed to connect to PostgreSQL!${NC}"
    echo "Please check your credentials and try again."
    exit 1
fi
echo -e "${GREEN}✅ Successfully connected to PostgreSQL${NC}"
echo ""

# Check if database exists
echo "Checking if database '$DB_NAME' exists..."
DB_EXISTS=$(psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")

if [ "$DB_EXISTS" = "1" ]; then
    echo -e "${YELLOW}⚠️  Database '$DB_NAME' already exists${NC}"
    echo "Do you want to drop and recreate it? (yes/no)"
    read -r RESPONSE
    if [ "$RESPONSE" = "yes" ]; then
        echo "Dropping existing database..."
        psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d postgres -c "DROP DATABASE $DB_NAME;"
        echo -e "${GREEN}✅ Database dropped${NC}"
    else
        echo "Using existing database..."
    fi
fi

# Create database if it doesn't exist
if [ "$DB_EXISTS" != "1" ] || [ "$RESPONSE" = "yes" ]; then
    echo "Creating database '$DB_NAME'..."
    psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d postgres -c "CREATE DATABASE $DB_NAME;"
    echo -e "${GREEN}✅ Database created${NC}"
fi
echo ""

# Update .env file
echo "Updating .env file..."
cat > ../.env << EOF
# Application Configuration
NODE_ENV=development
PORT=3000
API_PREFIX=api/v1

# Database Configuration - PostgreSQL Only
DB_TYPE=postgres
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_USERNAME=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_DATABASE=$DB_NAME
DB_SYNCHRONIZE=false
DB_LOGGING=true

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production-12345
JWT_EXPIRES_IN=24h
JWT_REFRESH_SECRET=your-super-secret-refresh-key-change-this-in-production-67890
JWT_REFRESH_EXPIRES_IN=7d

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# File Storage Configuration
FILE_STORAGE_PATH=./uploads
MAX_FILE_SIZE=5242880
ALLOWED_FILE_TYPES=jpg,jpeg,png,pdf

# Rate Limiting
THROTTLE_TTL=60
THROTTLE_LIMIT=100

# Logging Configuration
LOG_LEVEL=debug
LOG_FILE_PATH=./logs

# Email Configuration (Optional)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noreply@loanmanagement.com

# Backup Configuration
BACKUP_PATH=./backups
BACKUP_RETENTION_DAYS=30
EOF
echo -e "${GREEN}✅ .env file updated${NC}"
echo ""

# Remove SQLite database file
if [ -f "../loan_management.db" ]; then
    echo "Found SQLite database file. Do you want to remove it? (yes/no)"
    read -r REMOVE_SQLITE
    if [ "$REMOVE_SQLITE" = "yes" ]; then
        mv ../loan_management.db ../loan_management.db.backup
        echo -e "${GREEN}✅ SQLite database backed up to loan_management.db.backup${NC}"
    fi
fi
echo ""

# Install/Update dependencies
echo "Installing dependencies..."
cd ..
npm install
echo -e "${GREEN}✅ Dependencies installed${NC}"
echo ""

# Run migrations
echo "Running database migrations..."
npm run migration:run
echo -e "${GREEN}✅ Migrations completed${NC}"
echo ""

echo "=========================================="
echo -e "${GREEN}✅ Migration to PostgreSQL completed!${NC}"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Review the .env file and update any necessary configurations"
echo "2. Start your application: npm run start:dev"
echo "3. Verify the database connection"
echo ""
echo "For more information, see POSTGRESQL_SETUP.md"
