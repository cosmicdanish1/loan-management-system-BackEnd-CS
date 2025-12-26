import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import * as Joi from 'joi';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseConfig } from './config/database.config';
import { AuthModule } from './modules/auth/auth.module';
import { MemberModule } from './modules/member/member.module';
import { LoanModule } from './modules/loan/loan.module';
import { DepositModule } from './modules/deposit/deposit.module';
import { TransactionModule } from './modules/transaction/transaction.module';
import { ReportModule } from './modules/report/report.module';
import { AdminModule } from './modules/admin/admin.module';
import { UtilityModule } from './modules/utility/utility.module';
import { SearchModule } from './modules/search/search.module';
import { BackupModule } from './modules/backup/backup.module';
import { InterestModule } from './modules/interest/interest.module';
import { CashBookModule } from './modules/cashbook/cashbook.module';
import { DayBookModule } from './modules/daybook/daybook.module';
import { ConsolidationModule } from './modules/consolidation/consolidation.module';
import { MemberLedgerModule } from './modules/member-ledger/member-ledger.module';
import { GeneralLedgerModule } from './modules/general-ledger/general-ledger.module';
import { PrintVoucherModule } from './modules/print-voucher/print-voucher.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';

@Module({
  imports: [
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
      useFactory: (configService: ConfigService) => ({
        transports: [
          new winston.transports.Console({
            format: winston.format.combine(
              winston.format.timestamp(),
              winston.format.colorize(),
              winston.format.simple(),
            ),
          }),
          new winston.transports.File({
            filename: `${configService.get('LOG_FILE_PATH', './logs')}/error.log`,
            level: 'error',
            format: winston.format.combine(
              winston.format.timestamp(),
              winston.format.json(),
            ),
          }),
          new winston.transports.File({
            filename: `${configService.get('LOG_FILE_PATH', './logs')}/combined.log`,
            format: winston.format.combine(
              winston.format.timestamp(),
              winston.format.json(),
            ),
          }),
        ],
      }),
    }),

    // Feature modules
    AuthModule,
    MemberModule,
    LoanModule,
    DepositModule,
    TransactionModule,
    ReportModule,
    AdminModule,
    UtilityModule,
    SearchModule,
    BackupModule,
    InterestModule,
    CashBookModule,
    DayBookModule,
    ConsolidationModule,
    MemberLedgerModule,
    GeneralLedgerModule,
    PrintVoucherModule,
    AnalyticsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
