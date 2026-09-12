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
- **Caching**: Redis

## Getting Started

### Prerequisites

- Node.js 18+ (LTS recommended)
- PostgreSQL 13+
- Redis 6+
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
├── modules/                # Feature modules
│   ├── auth/              # Authentication module
│   ├── member/            # Member management
│   ├── loan/              # Loan processing
│   ├── deposit/           # Deposit management
│   ├── transaction/       # Transaction processing
│   ├── report/            # Report generation
│   ├── admin/             # Administration
│   └── utility/           # Utility services
├── migrations/            # Database migrations
├── app.module.ts          # Root application module
└── main.ts               # Application entry point
```

## API Endpoints

### Authentication
- `POST /api/v1/auth/login` - User login
- `POST /api/v1/auth/logout` - User logout
- `POST /api/v1/auth/refresh` - Refresh token

### Members
- `GET /api/v1/members` - Get all members
- `POST /api/v1/members` - Create new member
- `GET /api/v1/members/:id` - Get member by ID
- `PUT /api/v1/members/:id` - Update member
- `DELETE /api/v1/members/:id` - Delete member

### Loans
- `GET /api/v1/loans` - Get all loans
- `POST /api/v1/loans` - Create loan application
- `GET /api/v1/loans/:id` - Get loan details
- `POST /api/v1/loans/:id/payments` - Record loan payment

### Deposits
- `GET /api/v1/deposits` - Get all deposits
- `POST /api/v1/deposits/fixed` - Create fixed deposit
- `POST /api/v1/deposits/recurring` - Create recurring deposit
- `GET /api/v1/deposits/:id/certificate` - Generate certificate

### Transactions
- `GET /api/v1/transactions` - Get all transactions
- `POST /api/v1/transactions` - Create transaction
- `POST /api/v1/transactions/vouchers` - Create voucher

### Reports
- `GET /api/v1/reports/daily` - Daily reports
- `GET /api/v1/reports/monthly` - Monthly reports
- `GET /api/v1/reports/yearly` - Yearly reports

## Environment Variables

```env
# Application
NODE_ENV=development
PORT=3000
API_PREFIX=api/v1

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=password
DB_DATABASE=loan_management_db

# JWT
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=24h

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
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

### Docker Deployment

1. **Build Docker image**
   ```bash
   docker build -t loan-management-api .
   ```

2. **Run with Docker Compose**
   ```bash
   docker-compose up -d
   ```

### Production Deployment

1. **Build application**
   ```bash
   npm run build
   ```

2. **Start production server**
   ```bash
   npm run start:prod
   ```

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