import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MOBILE_DS } from './mobile.constants';
import { MemberJwtGuard } from './auth/member-jwt.guard';
import { MemberJwtStrategy } from './auth/member-jwt.strategy';
import { resolveMemberSecret } from './auth/member-secret';
import { MemberTokenService } from './auth/member-token.service';
import { MobileAuditInterceptor } from './audit/mobile-audit.interceptor';
import { MobileAuditService } from './audit/mobile-audit.service';
import { MobileThrottlerGuard } from './security/mobile-throttler.guard';
import { MobileStatusController } from './status/mobile-status.controller';
import { MobileStatusService } from './status/mobile-status.service';
import { ActivationService } from './access/activation.service';
import { AppCodeService } from './access/app-code.service';
import { MemberAuthService } from './access/member-auth.service';
import { MemberDirectoryService } from './access/member-directory.service';
import { MobileAuthController } from './access/mobile-auth.controller';
import { MobileCryptoService } from './access/mobile-crypto';
import { SessionService } from './access/session.service';
import { MobileAdminController } from './admin/mobile-admin.controller';
import { MobileAdminService } from './admin/mobile-admin.service';
import { MobileBootstrapService } from './mobile-bootstrap.service';
import { FeatureFlagService } from './data/feature-flag.service';
import { MemberDataController } from './data/member-data.controller';
import { MemberDataService } from './data/member-data.service';
import { LoanV2Module } from '../loan/loan-v2.module';
import { MemberLedgerModule } from '../member-ledger/member-ledger.module';
import { MemberV2Module } from '../member/member-v2.module';
import { AdmissionService } from './queue/admission.service';
import { PriorityMiddleware } from './queue/priority.middleware';

/**
 * Member mobile app API: everything under /api/v1/mobile. Isolated from the staff API on purpose (PRD section 12):
 *  - its own member token (JWT_MEMBER_SECRET), never accepted by staff routes and vice versa (ES-216)
 *  - its own rate limits (ES-217)
 *  - its own small database pool with a statement timeout, so a burst cannot starve desktop users (ES-222)
 *  - an audit trail (ES-224)
 * Routes are added here step by step (activation, login, member data...).
 */
@Module({
  imports: [
    ConfigModule,
    PassportModule,
    // Member data comes from the SAME services the desktop uses, so phone and counter show the same numbers.
    LoanV2Module,
    MemberV2Module,
    MemberLedgerModule,

    // Separate, small pool (ES-222). No entities: the module uses plain SQL on mobile_* tables.
    TypeOrmModule.forRootAsync({
      name: MOBILE_DS,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('DB_HOST', 'localhost'),
        port: Number(config.get('DB_PORT', 5432)),
        username: config.get<string>('DB_USERNAME', 'postgres'),
        password: config.get<string>('DB_PASSWORD', 'postgres'),
        database: config.get<string>('DB_DATABASE', 'loan_management_db'),
        entities: [],
        synchronize: false,
        logging: false,
        ssl: config.get('NODE_ENV') === 'production' ? { rejectUnauthorized: false } : false,
        extra: {
          max: Number(config.get('MOBILE_DB_POOL_MAX', 6)),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
          statement_timeout: Number(config.get('MOBILE_DB_STATEMENT_TIMEOUT_MS', 5000)),
          application_name: 'fibe-mobile',
        },
      }),
    }),

    // Member access token, 15 minutes, signed with the member secret.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: resolveMemberSecret(config),
        signOptions: { expiresIn: config.get<string>('MOBILE_ACCESS_TOKEN_TTL', '15m') },
      }),
    }),

    // Mobile-only rate limit: default 300 requests / 60 s per IP (many members can share one mobile-network IP).
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: Number(config.get('MOBILE_THROTTLE_TTL', 60)) * 1000,
          limit: Number(config.get('MOBILE_THROTTLE_LIMIT', 300)),
        },
      ],
    }),
  ],
  controllers: [MobileStatusController, MobileAuthController, MemberDataController, MobileAdminController],
  providers: [
    MemberJwtStrategy,
    MemberJwtGuard,
    MemberTokenService,
    MobileAuditService,
    MobileAuditInterceptor,
    MobileThrottlerGuard,
    MobileStatusService,
    MobileCryptoService,
    MemberDirectoryService,
    SessionService,
    ActivationService,
    MemberAuthService,
    AppCodeService,
    MobileAdminService,
    MobileBootstrapService,
    AdmissionService,
    FeatureFlagService,
    MemberDataService,
  ],
  exports: [MemberTokenService, MobileAuditService, MemberJwtGuard, AppCodeService, AdmissionService],
})
export class MobileModule implements NestModule {
  /** Staff first, members last (ES-386): the priority gate sees EVERY request, staff and mobile. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(PriorityMiddleware).forRoutes('*');
  }
}
