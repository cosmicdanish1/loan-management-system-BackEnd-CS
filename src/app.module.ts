import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { WinstonModule } from 'nest-winston';
import { createWinstonConfig } from './common/logging/logging.config';
import * as Joi from 'joi';
import * as crypto from 'crypto';
import { ClsModule } from 'nestjs-cls';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseConfig } from './config/database.config';
import { AuthModule } from './modules/auth/auth.module';
import { DepositModule } from './modules/deposit/deposit.module';
import { RdModule } from './modules/rd/rd.module';
import { AiChatModule } from './modules/ai-chat/ai-chat.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { DividendModule } from './modules/dividend/dividend.module';
import { AdminModule } from './modules/admin/admin.module';
import { UtilityModule } from './modules/utility/utility.module';
import { UtilitiesModule } from './modules/utilities/utilities.module';
import { SearchModule } from './modules/search/search.module';
import { BackupModule } from './modules/backup/backup.module';
import { InterestModule } from './modules/interest/interest.module';
import { CashBookModule } from './modules/cashbook/cashbook.module';
import { DayBookModule } from './modules/daybook/daybook.module';
import { ConsolidationModule } from './modules/consolidation/consolidation.module';
import { MemberLedgerModule } from './modules/member-ledger/member-ledger.module';
import { GeneralLedgerModule } from './modules/general-ledger/general-ledger.module';
import { PrintVoucherModule } from './modules/print-voucher/print-voucher.module';
import { JottingReportModule } from './modules/jotting-report/jotting-report.module';
import { ReportHeadOrderModule } from './modules/report-head-order/report-head-order.module';
import { SharedModule } from './modules/shared/shared.module';
import { MemberV2Module } from './modules/member/member-v2.module';
import { LoanV2Module } from './modules/loan/loan-v2.module';
import { TransactionV2Module } from './modules/transaction/transaction-v2.module';
import { ReportV2Module } from './modules/report/report-v2.module';
import { NotificationModule } from './modules/notification/notification.module';
import { LicenseModule } from './modules/license/license.module';
import { ClientLogsModule } from './modules/client-logs/client-logs.module';
import { NoticeModule } from './modules/notice/notice.module';
import { SupportModule } from './modules/support/support.module';
import { MobileModule } from './modules/mobile/mobile.module';
import { SystemUpdateModule } from './modules/system-update/system-update.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { MemberStatusModule } from './modules/member-status/member-status.module';
import { GroupInsuranceModule } from './modules/group-insurance/group-insurance.module';
import { NotificationCentreModule } from './modules/notification-centre/notification-centre.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { EasterEggsModule } from './modules/easter-eggs/easter-eggs.module';
import { LoggingModule } from './common/logging/logging.module';

@Module({
  imports: [
    // Correlation id: one id per request, shared by the screen (X-Request-Id), every server log line and the
    // error response (requestId), so support can find the exact log line for an error a user reports (ES-444).
    // useEnterWith: true because this Express setup loses context with the default run()-wrapping.
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        useEnterWith: true,
        // Honour an inbound X-Request-Id only when it is a short, plain token (it ends up in log files); else mint one.
        idGenerator: (req: any) => {
          const inbound = String(req.headers['x-request-id'] ?? '');
          return /^[A-Za-z0-9_.-]{6,64}$/.test(inbound) ? inbound : `req-${crypto.randomBytes(6).toString('hex')}`;
        },
        setup: (cls: any, req: any, res: any) => {
          const id = cls.getId();
          req.requestId = id; // read by the access-log interceptor and the exception filter
          res.setHeader('X-Request-Id', id); // echoed back to the screen
        },
      },
    }),

    // Configuration module with validation
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
        PORT: Joi.number().default(3000),
        API_PREFIX: Joi.string().default('api/v1'),
        DB_TYPE: Joi.string().valid('sqlite', 'postgres').default('sqlite'),
        DB_HOST: Joi.string().optional(),
        DB_PORT: Joi.number().default(5432),
        DB_USERNAME: Joi.string().optional(),
        DB_PASSWORD: Joi.string().optional(),
        DB_DATABASE: Joi.string().default('loan_management.db'),
        JWT_SECRET: Joi.string().required(),
        JWT_EXPIRES_IN: Joi.string().default('24h'),
        JWT_REFRESH_SECRET: Joi.string().required(),
        JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),
        REDIS_HOST: Joi.string().default('localhost'),
        REDIS_PORT: Joi.number().default(6379),
      }),
    }),

    // Database configuration
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useClass: DatabaseConfig,
      inject: [ConfigService],
    }),

    // Analytics Database configuration (separate database)
    TypeOrmModule.forRootAsync({
      name: 'analytics',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DB_HOST', 'localhost'),
        port: configService.get('DB_PORT', 5432),
        username: configService.get('DB_USERNAME', 'postgres'),
        password: configService.get('DB_PASSWORD', 'password'),
        database: 'EMP_Analytics_DB', // Separate analytics database
        entities: [
          __dirname + '/modules/analytics/entities/*.entity{.ts,.js}',
        ],
        synchronize: configService.get('NODE_ENV') === 'development',
        logging: configService.get('NODE_ENV') === 'development',
        ssl: configService.get('NODE_ENV') === 'production' ? { rejectUnauthorized: false } : false,
      }),
    }),

    // Rate limiting
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => [
        {
          ttl: configService.get('THROTTLE_TTL', 60) * 1000,
          limit: configService.get('THROTTLE_LIMIT', 100),
        },
      ],
    }),

    // Logging configuration
    WinstonModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => createWinstonConfig(configService),
    }),

    // Feature modules
    LoggingModule, // Global — audit/service/http-access logging
    SharedModule, // Global shared services (sequences, utilities)
    AuthModule,
    MemberV2Module, // Restructured member services
    LoanV2Module, // Restructured loan services
    DepositModule,
    RdModule,
    // Floating help chat bot (ES-372). Keys come from .env; without keys it answers "not configured". JWT-guarded globally.
    AiChatModule,
    AnalyticsModule, // ES-120: the 'analytics' connection above (EMP_Analytics_DB) already exists; the module was never mounted
    DividendModule,
    TransactionV2Module, // Restructured transaction services
    ReportV2Module, // Restructured report services
    AdminModule,
    UtilityModule,
    UtilitiesModule,
    SearchModule,
    BackupModule,
    InterestModule,
    CashBookModule,
    DayBookModule,
    ConsolidationModule,
    MemberLedgerModule,
    GeneralLedgerModule,
    PrintVoucherModule,
    JottingReportModule,
    ReportHeadOrderModule,
    NotificationModule,
    LicenseModule,
    ClientLogsModule,
    NoticeModule,
    EasterEggsModule,
    AlertsModule, // Telegram alerts: errors, logins, backups, licence, daily digest
    SupportModule, // Raise a Query desk (Jira + Telegram)
    MobileModule, // Fibe Mobile member app API (/api/v1/mobile): isolated token, limits, DB pool
    SystemUpdateModule, // Upload and apply a backend release zip (admin only)
    OnboardingModule, // First-login walkthrough (ES-146)
    MemberStatusModule, // ES-100: retired / inactive member flagging
    GroupInsuranceModule, // ES-98: yearly group insurance deducted from RD
    NotificationCentreModule, // ES-101: all system notifications in one place
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
