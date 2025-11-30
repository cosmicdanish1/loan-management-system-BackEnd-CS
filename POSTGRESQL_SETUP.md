# PostgreSQL Database Setup Guide

This application uses **PostgreSQL** as its database. Follow the steps below to set up PostgreSQL for the Loan Management System.

---

## 📋 Prerequisites

- PostgreSQL 12 or higher installed on your system
- Access to PostgreSQL command line or pgAdmin

---

## 🚀 Installation

### Windows

1. **Download PostgreSQL**:
   - Visit: https://www.postgresql.org/download/windows/
   - Download the installer for Windows
   - Run the installer and follow the setup wizard

2. **During Installation**:
   - Set a password for the `postgres` superuser (remember this!)
   - Default port: `5432`
   - Install pgAdmin 4 (recommended for GUI management)

3. **Verify Installation**:
   ```cmd
   psql --version
   ```

### macOS

```bash
# Using Homebrew
brew install postgresql@15

# Start PostgreSQL service
brew services start postgresql@15

# Verify installation
psql --version
```

### Linux (Ubuntu/Debian)

```bash
# Update package list
sudo apt update

# Install PostgreSQL
sudo apt install postgresql postgresql-contrib

# Start PostgreSQL service
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Verify installation
psql --version
```

---

## 🗄️ Database Setup

### Step 1: Access PostgreSQL

**Windows (Command Prompt):**
```cmd
psql -U postgres
```

**macOS/Linux:**
```bash
sudo -u postgres psql
```

### Step 2: Create Database

```sql
-- Create the database
CREATE DATABASE loan_management_db;

-- Create a dedicated user (optional but recommended)
CREATE USER loan_admin WITH ENCRYPTED PASSWORD 'your_secure_password';

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE loan_management_db TO loan_admin;

-- Connect to the database
\c loan_management_db

-- Grant schema privileges
GRANT ALL ON SCHEMA public TO loan_admin;

-- Exit
\q
```

### Step 3: Verify Database Creation

```bash
# List all databases
psql -U postgres -l

# You should see 'loan_management_db' in the list
```

---

## ⚙️ Configuration

### Update `.env` File

Make sure your `backend/.env` file has the correct PostgreSQL configuration:

```properties
# Database Configuration - PostgreSQL Only
DB_TYPE=postgres
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=your_password_here
DB_DATABASE=loan_management_db
DB_SYNCHRONIZE=false
DB_LOGGING=true
```

### Important Notes:

- **DB_SYNCHRONIZE**: Set to `false` in production to prevent automatic schema changes
- **DB_LOGGING**: Set to `true` for development, `false` for production
- **DB_PASSWORD**: Use a strong password in production

---

## 🔄 Running Migrations

### Generate Migration

```bash
cd backend
npm run migration:generate -- src/migrations/InitialSchema
```

### Run Migrations

```bash
npm run migration:run
```

### Revert Last Migration

```bash
npm run migration:revert
```

---

## 🧪 Testing Connection

### Method 1: Using psql

```bash
psql -U postgres -d loan_management_db -c "SELECT version();"
```

### Method 2: Using Node.js Test Script

Create a test file `backend/test-db-connection.js`:

```javascript
const { Client } = require('pg');

const client = new Client({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'your_password',
  database: 'loan_management_db',
});

client.connect()
  .then(() => {
    console.log('✅ Connected to PostgreSQL successfully!');
    return client.query('SELECT NOW()');
  })
  .then(result => {
    console.log('Current time from database:', result.rows[0].now);
    return client.end();
  })
  .catch(err => {
    console.error('❌ Connection error:', err.message);
  });
```

Run the test:
```bash
node test-db-connection.js
```

---

## 🛠️ Common Issues & Solutions

### Issue 1: Connection Refused

**Error**: `ECONNREFUSED 127.0.0.1:5432`

**Solution**:
```bash
# Check if PostgreSQL is running
# Windows:
sc query postgresql-x64-15

# macOS:
brew services list

# Linux:
sudo systemctl status postgresql
```

### Issue 2: Authentication Failed

**Error**: `password authentication failed for user "postgres"`

**Solution**:
1. Reset PostgreSQL password:
   ```bash
   # Windows (as Administrator):
   psql -U postgres
   ALTER USER postgres PASSWORD 'new_password';
   
   # Linux:
   sudo -u postgres psql
   ALTER USER postgres PASSWORD 'new_password';
   ```

2. Update `.env` file with the new password

### Issue 3: Database Does Not Exist

**Error**: `database "loan_management_db" does not exist`

**Solution**:
```bash
psql -U postgres -c "CREATE DATABASE loan_management_db;"
```

### Issue 4: Port Already in Use

**Error**: `Port 5432 is already in use`

**Solution**:
1. Check what's using the port:
   ```bash
   # Windows:
   netstat -ano | findstr :5432
   
   # macOS/Linux:
   lsof -i :5432
   ```

2. Either stop the conflicting service or change PostgreSQL port in `postgresql.conf`

---

## 📊 Database Management Tools

### pgAdmin 4 (GUI)

1. **Open pgAdmin 4**
2. **Add Server**:
   - Name: Loan Management
   - Host: localhost
   - Port: 5432
   - Username: postgres
   - Password: your_password
3. **Connect** and manage your database visually

### DBeaver (Alternative GUI)

1. Download from: https://dbeaver.io/
2. Create new PostgreSQL connection
3. Enter connection details
4. Test connection and save

### Command Line (psql)

```bash
# Connect to database
psql -U postgres -d loan_management_db

# Common commands:
\l              # List all databases
\dt             # List all tables
\d table_name   # Describe table structure
\du             # List all users
\q              # Quit
```

---

## 🔐 Security Best Practices

1. **Use Strong Passwords**:
   - Minimum 12 characters
   - Mix of uppercase, lowercase, numbers, and symbols

2. **Create Dedicated User**:
   - Don't use `postgres` superuser for the application
   - Create a user with limited privileges

3. **Enable SSL** (Production):
   ```properties
   # In .env
   DB_SSL=true
   ```

4. **Regular Backups**:
   ```bash
   # Backup database
   pg_dump -U postgres loan_management_db > backup.sql
   
   # Restore database
   psql -U postgres loan_management_db < backup.sql
   ```

5. **Firewall Configuration**:
   - Only allow connections from trusted IPs
   - Use VPN for remote database access

---

## 🚀 Starting the Application

Once PostgreSQL is set up:

```bash
# Install dependencies (if not already done)
cd backend
npm install

# Run migrations
npm run migration:run

# Start the application
npm run start:dev
```

The backend will connect to PostgreSQL automatically using the configuration in `.env`.

---

## 📝 Additional Resources

- **PostgreSQL Documentation**: https://www.postgresql.org/docs/
- **TypeORM Documentation**: https://typeorm.io/
- **NestJS Database Guide**: https://docs.nestjs.com/techniques/database

---

## ✅ Verification Checklist

- [ ] PostgreSQL installed and running
- [ ] Database `loan_management_db` created
- [ ] User credentials configured in `.env`
- [ ] Connection test successful
- [ ] Migrations run successfully
- [ ] Application starts without database errors

---

## 🆘 Need Help?

If you encounter issues:

1. Check PostgreSQL logs:
   - Windows: `C:\Program Files\PostgreSQL\15\data\log\`
   - macOS: `/usr/local/var/postgres/`
   - Linux: `/var/log/postgresql/`

2. Verify `.env` configuration
3. Test connection using `psql` command line
4. Check firewall settings
5. Ensure PostgreSQL service is running

---

**Last Updated**: November 2024
**PostgreSQL Version**: 15.x or higher recommended
