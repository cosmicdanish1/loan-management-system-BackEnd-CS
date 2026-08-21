import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { WinstonModule } from 'nest-winston';
import { ClsModule } from 'nestjs-cls';
import * as crypto from 'crypto';
import * as Joi from 'joi';
import { createWinstonConfig } from './common/logging/logging.config';
import { TypeOrmWinstonLogger } from './common/logging/typeorm.logger';
import { LoggingModule } from './common/logging/logging.module';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseConfig } from './config/database.config';
import { AuthModule } from './modules/auth/auth.module';
import { DepositModule } from './modules/deposit/deposit.module';
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
import { SharedModule } from './modules/shared/shared.module';
import { MemberV2Module } from './modules/member/member-v2.module';
import { LoanV2Module } from './modules/loan/loan-v2.module';
import { TransactionV2Module } from './modules/transaction/transaction-v2.module';
import { ReportV2Module } from './modules/report/report-v2.module';
import { NotificationModule } from './modules/notification/notification.module';
import { NoticeModule } from './modules/notice/notice.module';
import { LicenseModule } from './modules/license/license.module';
import { AiChatModule } from './modules/ai-chat/ai-chat.module';
import { ClientLogsModule } from './modules/client-logs/client-logs.module';

@Module({
  imports: [
    // Request-scoped context (correlation id) — bound to the whole Nest
    // pipeline so every service/DB/error log line carries the same requestId.
    // useEnterWith: true because this Express setup loses context with the
    // default run()-wrapping (verified empirically).
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        debug: false,
        generateId: true,
        useEnterWith: true,
        // Honor an inbound X-Request-Id (from the frontend) so the trace
        // spans UI → API; otherwise mint one.
        idGenerator: (req: any) =>
          (req.headers['x-request-id'] as string) ||
          `req-${crypto.randomBytes(6).toString('hex')}`,
        setup: (cls, req: any, res: any) => {
          const id = cls.getId();
          req.requestId = id; // consumed by HttpAccess interceptor + exception filter
          res.setHeader('X-Request-Id', id); // echoed back to the frontend
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

    // Logging configuration — rotation, per-service routing, redaction
    WinstonModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => createWinstonConfig(configService),
    }),

    // Global logging (AuditLogService available everywhere)
    LoggingModule,

    // Feature modules
    SharedModule, // Global shared services (sequences, utilities)
    AuthModule,
    MemberV2Module, // Restructured member services
    LoanV2Module, // Restructured loan services
    DepositModule,
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
    NotificationModule,
    NoticeModule,
    LicenseModule,
    AiChatModule,
    ClientLogsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
