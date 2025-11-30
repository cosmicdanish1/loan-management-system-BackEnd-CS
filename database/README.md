# 🗄️ Database Schema Documentation

This folder contains all database-related documentation, schemas, migrations, and queries for the Loan Management System.

## 📁 Folder Structure

```
database/
├── schemas/           # Table structure definitions (CREATE TABLE statements)
├── migrations/        # Database migration scripts
├── seeds/            # Sample data for testing
├── queries/          # Common SQL queries and stored procedures
└── README.md         # This file
```

## 📋 Purpose

This centralized database documentation serves as:

1. **Reference Guide**: Quick lookup for table structures and relationships
2. **Version Control**: Track all database schema changes
3. **Onboarding**: Help new developers understand the database structure
4. **Backup**: Keep SQL scripts for recreating tables if needed
5. **Documentation**: Maintain a single source of truth for database design

## 🗂️ Schemas Folder (`/schemas`)

Contains CREATE TABLE statements for all database tables, organized by module:

- `01-users-and-auth.sql` - User authentication and authorization tables
- `02-members.sql` - Member management tables
- `03-accounts.sql` - Account management (FD, RD, SB)
- `04-loans.sql` - Loan management tables
- `05-transactions.sql` - Transaction and voucher tables
- `06-reports.sql` - Reporting and audit tables
- `07-system.sql` - System configuration tables

## 🔄 Migrations Folder (`/migrations`)

Contains timestamped migration files for schema changes:

- Format: `YYYYMMDD_HHMMSS_description.sql`
- Example: `20241117_120000_add_member_kyc_fields.sql`

## 🌱 Seeds Folder (`/seeds`)

Contains sample data for development and testing:

- `01-seed-users.sql` - Sample users
- `02-seed-members.sql` - Sample members
- `03-seed-accounts.sql` - Sample accounts
- `04-seed-transactions.sql` - Sample transactions

## 📝 Queries Folder (`/queries`)

Contains commonly used SQL queries:

- `common-queries.sql` - Frequently used SELECT queries
- `reports.sql` - Report generation queries
- `maintenance.sql` - Database maintenance queries
- `stored-procedures.sql` - Stored procedures and functions

## 🚀 Usage

### Viewing Table Structure

```bash
# Navigate to schemas folder
cd backend/database/schemas

# View a specific table schema
cat 02-members.sql
```

### Creating New Migration

```bash
# Create a new migration file
cd backend/database/migrations
touch $(date +%Y%m%d_%H%M%S)_your_migration_name.sql
```

### Running Migrations

```bash
# Using TypeORM
cd backend
npm run migration:run
```

### Applying Schema Changes

```bash
# Connect to PostgreSQL
psql -U postgres -d loan_management_db

# Run a schema file
\i database/schemas/02-members.sql
```

## 📊 Database Diagram

For a visual representation of the database structure, see:
- `database/diagrams/erd.png` - Entity Relationship Diagram
- `database/diagrams/schema-overview.md` - Text-based schema overview

## 🔐 Best Practices

1. **Always backup** before running migrations
2. **Test migrations** in development first
3. **Document changes** in migration files
4. **Use transactions** for complex migrations
5. **Keep schemas updated** when making changes
6. **Version control** all database files

## 📚 Additional Resources

- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [TypeORM Migrations](https://typeorm.io/migrations)
- [Database Design Best Practices](https://www.postgresql.org/docs/current/ddl.html)

---

**Last Updated**: November 2024  
**Database**: PostgreSQL 15.x  
**ORM**: TypeORM 0.3.x
