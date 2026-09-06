# Loan Management System - Backend API

A comprehensive NestJS backend API for the Loan Management System built with TypeScript, PostgreSQL, and modern development practices.

## Features

- **Authentication & Authorization** - JWT-based auth with role-based access control
- **Member Management** - Complete member lifecycle management
- **Loan Processing** - Loan applications, disbursement, and payment tracking
- **Deposit Management** - Fixed deposits, recurring deposits, and certificates
- **Transaction Processing** - Double-entry bookkeeping and voucher management
- **Comprehensive Reporting** - Daily, monthly, and yearly financial reports
- **System Administration** - User management, configuration, and backup/restore
- **Utility Services** - Calculations, search, and data maintenance tools

## Technology Stack

- **Framework**: NestJS 10.x with TypeScript
- **Database**: PostgreSQL with TypeORM
- **Authentication**: JWT with Passport
- **Validation**: Class Validator & Class Transformer
- **Documentation**: Swagger/OpenAPI
- **Testing**: Jest
- **Logging**: Winston

## Getting Started

### Prerequisites

- Node.js 18+ (LTS recommended)
- PostgreSQL 13+
- npm or yarn

### Installation

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Environment Setup**
   ```bash
   cp .env.example .env
   # Update the .env file with your configuration
   ```

3. **Database Setup**
   ```bash
   # Create database
   createdb loan_management_db
   
   # Run migrations
   npm run migration:run
   ```

### Development

1. **Start Development Server**
   ```bash
   npm run start:dev
   ```

2. **API Documentation**
   - Swagger UI: http://localhost:3000/api/docs
   - API Base URL: http://localhost:3000/api/v1

### Available Scripts

- `npm run start` - Start production server
- `npm run start:dev` - Start development server with hot reload
- `npm run start:debug` - Start server in debug mode
- `npm run build` - Build for production
- `npm run test` - Run unit tests
- `npm run test:e2e` - Run end-to-end tests
- `npm run test:cov` - Generate test coverage report
- `npm run lint` - Lint and fix code
- `npm run format` - Format code with Prettier
- `npm run openapi:generate` - Regenerate the OpenAPI spec, Postman collection & API reference
- `npm run docs:manual` - Rebuild the DOCX + PDF API manual

### Database Operations

- `npm run migration:generate -- MigrationName` - Generate new migration
- `npm run migration:run` - Run pending migrations
- `npm run migration:revert` - Revert last migration

## Project Structure

```
src/
├── config/                 # Configuration files
│   └── database.config.ts  # Database configuration
├── common/                 # Shared utilities
│   ├── decorators/         # Custom decorators
│   ├── filters/            # Exception filters
│   └── interceptors/       # Response interceptors
├── modules/                # Feature modules (26)
│   ├── admin/             # Administration, day-end, financial year, masters
│   ├── auth/              # Authentication & authorization
│   ├── member/            # Member management
│   ├── loan/              # Loan processing
│   ├── deposit/           # Fixed & recurring deposits
│   ├── transaction/       # Transactions, vouchers, demand generation
│   ├── report/            # Report generation
│   ├── general-ledger/    # General ledger
│   ├── member-ledger/     # Member ledger
│   ├── daybook/           # Daybook
│   ├── cashbook/          # Cash book
│   ├── interest/          # Interest calculation
│   ├── financial-year/    # Financial year management
│   ├── consolidation/     # Consolidation
│   ├── print-voucher/     # Voucher printing
│   ├── jotting-report/    # Jotting reports
│   ├── backup/            # Backup & restore
│   ├── license/           # Software license activation
│   ├── notification/      # Notifications
│   ├── notice/            # Dashboard notices
│   ├── search/            # Search services
│   ├── utilities/         # Utility screens
│   ├── utility/           # Utility services
│   ├── ai-chat/           # AI chat
│   ├── client-logs/       # Client-side log ingestion
│   └── shared/            # Shared providers
├── migrations/            # Database migrations
├── app.module.ts          # Root application module
└── main.ts               # Application entry point
```

## API Endpoints

The API exposes **479 endpoints across 47 groups**. They are **not listed here** —
a hand-maintained list drifts out of date. The generated reference is the source of
truth and lives in [`docs/api/`](docs/api/):

| File | Use it for |
| --- | --- |
| [`docs/api/API_REFERENCE.md`](docs/api/API_REFERENCE.md) | Every endpoint (method, path, purpose), grouped by module. Start here. |
| `docs/api/openapi.json` | Full OpenAPI 3.0 spec — import into Postman or any Swagger viewer. |
| `docs/api/LMS-API.postman_collection.json` | Ready-to-import Postman collection with `{{baseUrl}}` / `{{token}}` set up. |
| `docs/api/API_DOCUMENTATION.pdf` / `.docx` | Printable ~252-page manual: curl example and sample response per endpoint. |

See [`docs/api/README.md`](docs/api/README.md) for the Postman quick start.

**Regenerate after changing any controller or DTO** (no database needed):

```bash
npm run openapi:generate   # openapi.json, Postman collection, API_REFERENCE.md
npm run docs:manual        # rebuilds the DOCX + PDF manual
```

### Live Swagger UI

- UI:   `http://localhost:3000/api/docs`
- JSON: `http://localhost:3000/api/docs-json`

Enabled automatically outside production. In production it is **off by default** so
the API map isn't exposed on the LAN — set `ENABLE_SWAGGER=true` and restart to
turn it on temporarily.

## Environment Variables

Copy `.env.example` to `.env` and adjust. The full annotated list is in
[`.env.example`](.env.example); the essentials:

```env
# Application
NODE_ENV=development
PORT=3000                  # LAN deployments typically use 3001
API_PREFIX=api/v1
ENABLE_SWAGGER=false       # off in production; true to expose /api/docs

# Database (PostgreSQL only)
DB_TYPE=postgres
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=your_secure_password_here
DB_DATABASE=loan_management_db
DB_SYNCHRONIZE=false
DB_LOGGING=true

# JWT
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRES_IN=24h
JWT_REFRESH_SECRET=your-super-secret-refresh-key-change-this-in-production
JWT_REFRESH_EXPIRES_IN=7d

# File storage
FILE_STORAGE_PATH=./uploads
MAX_FILE_SIZE=5242880
ALLOWED_FILE_TYPES=jpg,jpeg,png,pdf

# Logging
LOG_LEVEL=debug
LOG_FILE_PATH=./logs
LOG_MAX_AGE_DAYS=60        # rotated .gz logs deleted after this many days

# Rate limiting
THROTTLE_TTL=60
THROTTLE_LIMIT=100

# Backup
BACKUP_PATH=./backups
BACKUP_RETENTION_DAYS=30
```

## Testing

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov
```

## Deployment

This project is deployed directly on the server (no containers).

1. **Build application**
   ```bash
   npm run build
   ```

2. **Start production server**
   ```bash
   npm run start:prod
   ```

For LAN deployment the server binds `0.0.0.0` and typically runs on port **3001**
(set `PORT` in `.env`); clients reach it at `http://<server-ip>:3001`.

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the ISC License.

## Support

For support and questions, please contact the development team at Bican Pvt. Ltd.