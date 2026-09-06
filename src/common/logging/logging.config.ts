import * as winston from 'winston';
import * as DailyRotateFile from 'winston-daily-rotate-file';
import * as path from 'path';
import { EventEmitter } from 'events';
import { ConfigService } from '@nestjs/config';
import { ClsServiceManager } from 'nestjs-cls';
import { REDACT_PATTERNS } from './redact';

// We deliberately pipe ~20 transports (6 shared + one DailyRotateFile per
// DOMAIN_FILES entry) into a single winston Logger. winston.createLogger()
// pipes each transport into the Logger stream, and stream.pipe() adds a
// 'data'/'end' listener on the source per destination — past Node's default
// cap of 10 that trips a spurious MaxListenersExceededWarning on boot, even
// though the transport count is fixed and never grows at runtime.
EventEmitter.defaultMaxListeners = Math.max(EventEmitter.defaultMaxListeners, 30);

// Service context → domain log file mapping
const SERVICE_DOMAIN_MAP: Record<string, string> = {
  // Auth domain
  AuthService: 'auth',
  AuthEnhancedService: 'auth',
  JwtStrategy: 'auth',
  LocalStrategy: 'auth',
  JwtAuthGuard: 'auth',
  PermissionsGuard: 'auth',
  RoleGuard: 'auth',
  HashPasswordService: 'auth',
  UserMasterEntity: 'auth',

  // Transaction domain
  VoucherService: 'transactions',
  PassTransactionService: 'transactions',
  JournalTransferService: 'transactions',
  CompulsoryDepositService: 'transactions',
  LedgerPostingService: 'transactions',
  DividendPaymentService: 'transactions',
  FixedDepositService: 'transactions',
  MemberBalanceTransferService: 'transactions',
  ShortRecoveryService: 'transactions',
  DemandGenerationService: 'transactions',
  DemandReportService: 'transactions',

  // Loan domain
  LoanApplicationService: 'loan',
  LoanEligibilityService: 'loan',
  LoanSanctionService: 'loan',
  LoanRepaymentService: 'loan',
  LoanSuretyService: 'loan',
  LoanQueryService: 'loan',
  LoanMonthEndService: 'loan',

  // Member domain
  MemberCrudService: 'member',
  MemberLookupService: 'member',
  MemberBalanceService: 'member',
  MemberAdminService: 'member',
  MemberFundsService: 'member',
  MemberLedgerService: 'member',
  SignatureService: 'member',

  // Interest domain
  InterestService: 'interest',
  InterestRateUpdateService: 'interest',
  DepositService: 'interest',
  CertificateService: 'interest',

  // Day-end domain
  DayEndService: 'day-end',
  FinancialYearService: 'day-end',

  // Reports domain
  DepositReportsService: 'reports',
  LoanReportsService: 'reports',
  UtilityReportsService: 'reports',
  MemberReportsService: 'reports',
  CashBookReportsService: 'reports',
  DividendReportsService: 'reports',
  FinancialStatementsService: 'reports',
  ProfitDistributionService: 'reports',
  GeneralLedgerService: 'reports',
  ConsolidationService: 'reports',
  DaybookService: 'reports',
  PrintVoucherService: 'reports',
  JottingReportService: 'reports',
  CashbookService: 'reports',

  // Admin domain
  UserManagementService: 'admin',
  RoleManagementService: 'admin',
  SystemConfigService: 'admin',
  CastCategoryService: 'admin',
  SbAccountService: 'admin',
  RdAccountService: 'admin',
  FdAccountService: 'admin',
  OfficeService: 'admin',
  WingService: 'admin',
  DesignationService: 'admin',
  PassbookTemplateService: 'admin',
  CertificateTemplateService: 'admin',
  SaakhScoreService: 'admin',
  AdminService: 'admin',

  // Backup domain
  BackupService: 'backup',

  // License domain
  LicenseService: 'license',

  // Notification domain
  NotificationService: 'notification',
};

export const DOMAIN_FILES = [
  'auth', 'transactions', 'loan', 'member', 'interest',
  'day-end', 'reports', 'admin', 'backup', 'license', 'notification',
  // Cross-cutting domains: every DB query, every API call, every frontend event.
  'db-queries', 'api', 'client',
];

const redactFormat = winston.format((info) => {
  if (typeof info.message === 'string') {
    for (const p of REDACT_PATTERNS) {
      info.message = (info.message as string).replace(p.regex, p.replacement);
    }
  }
  return info;
});

// Stamp every log record with the current request's correlation id (from the
// async-local store) so service, DB, and error logs can all be traced together.
// Skips records outside a request (bootstrap, migrations) and never overwrites
// an id a caller already set explicitly.
const requestIdFormat = winston.format((info) => {
  if (!info.requestId) {
    try {
      const rid = ClsServiceManager.getClsService().getId();
      if (rid) info.requestId = rid;
    } catch {
      /* outside a request context (bootstrap, cron, migrations) — no id */
    }
  }
  return info;
});

// Only let TypeORM query logs into the db-queries file, so SQL (logged at debug)
// stays isolated there and doesn't flood the console or the combined file.
const typeormFilter = winston.format((info) =>
  String(info.context || '') === 'TypeORM' ? info : false,
);

// Isolate audit and HTTP-access entries into their own files. Without these,
// createRotateTransport('audit'/'http-access') had no filterFormat and every
// context ended up in both files, duplicating the combined log.
const auditFilter = winston.format((info) =>
  String(info.context || '') === 'Audit' ? info : false,
);
const httpAccessFilter = winston.format((info) =>
  String(info.context || '') === 'HttpAccess' ? info : false,
);

function getLogPath(configService: ConfigService): string {
  return configService.get('LOG_FILE_PATH', './logs');
}

function getLogLevel(configService: ConfigService): string {
  return configService.get('LOG_LEVEL', 'info');
}

function getMaxSize(configService: ConfigService): string {
  return configService.get('LOG_MAX_SIZE', '50m');
}

function getMaxDays(configService: ConfigService): string {
  return configService.get('LOG_RETENTION_DAYS', '60d');
}

function createRotateTransport(
  logPath: string,
  filename: string,
  level: string | undefined,
  maxSize: string,
  maxDays: string,
  filterFormat?: ReturnType<typeof winston.format>,
): DailyRotateFile {
  const formats = [
    ...(filterFormat ? [filterFormat()] : []),
    requestIdFormat(),
    winston.format.timestamp(),
    redactFormat(),
    winston.format.json(),
  ];
  const opts: DailyRotateFile.DailyRotateFileTransportOptions = {
    dirname: logPath,
    filename: `${filename}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize,
    maxFiles: maxDays,
    format: winston.format.combine(...formats),
  };
  if (level) opts.level = level;
  return new DailyRotateFile(opts);
}

// Per-service domain transport — filters by context field
function createDomainTransport(
  logPath: string,
  domain: string,
  level: string,
  maxSize: string,
  maxDays: string,
): DailyRotateFile {
  const domainFilter = winston.format((info) => {
    const ctx = String(info.context || info.service || '');
    const mapped = SERVICE_DOMAIN_MAP[ctx];
    return mapped === domain ? info : false;
  });

  return new DailyRotateFile({
    dirname: path.join(logPath, 'services'),
    filename: `${domain}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    level,
    maxSize,
    maxFiles: maxDays,
    format: winston.format.combine(
      domainFilter(),
      requestIdFormat(),
      winston.format.timestamp(),
      redactFormat(),
      winston.format.json(),
    ),
  });
}

export function createWinstonConfig(configService: ConfigService): winston.LoggerOptions {
  const logPath = getLogPath(configService);
  const logLevel = getLogLevel(configService);
  const maxSize = getMaxSize(configService);
  const maxDays = getMaxDays(configService);
  const isDev = configService.get('NODE_ENV', 'development') !== 'production';

  const transports: winston.transport[] = [
    // Console — pretty in dev, JSON in prod
    new winston.transports.Console({
      level: logLevel,
      format: isDev
        ? winston.format.combine(
            requestIdFormat(),
            winston.format.timestamp({ format: 'HH:mm:ss' }),
            winston.format.colorize(),
            redactFormat(),
            winston.format.printf(({ timestamp, level, message, context, requestId, ...meta }) => {
              const ctx = context ? `[${context}]` : '';
              const rid = requestId ? ` (${requestId})` : '';
              const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
              return `${timestamp} ${level} ${ctx}${rid} ${message}${extra}`;
            }),
          )
        : winston.format.combine(
            requestIdFormat(),
            winston.format.timestamp(),
            redactFormat(),
            winston.format.json(),
          ),
    }),

    // Combined — everything at the configured level (SQL debug is excluded here)
    createRotateTransport(logPath, 'combined', logLevel, maxSize, maxDays),

    // Errors only
    createRotateTransport(logPath, 'error', 'error', maxSize, maxDays),

    // HTTP access — written by the access-log interceptor (context = 'HttpAccess')
    createRotateTransport(logPath, 'http-access', logLevel, maxSize, maxDays, httpAccessFilter),

    // DB queries — TypeORM SQL + results, captured at debug regardless of LOG_LEVEL
    createRotateTransport(logPath, 'db-queries', 'debug', maxSize, maxDays, typeormFilter),

    // Audit — written by audit service (context = 'Audit')
    createRotateTransport(logPath, 'audit', logLevel, '50m', '365d', auditFilter),
  ];

  // Per-domain service transports
  for (const domain of DOMAIN_FILES) {
    transports.push(createDomainTransport(logPath, domain, logLevel, maxSize, maxDays));
  }

  return {
    // Logger runs at debug so the db-queries transport can capture SQL; every
    // other transport filters up to LOG_LEVEL (info by default).
    level: 'debug',
    transports,
    handleExceptions: true,
    handleRejections: true,
    exitOnError: false,
  };
}

export { SERVICE_DOMAIN_MAP };
