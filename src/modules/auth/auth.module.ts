import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import {
  UserMaster,
  UserLevelMaster,
  MenuMaster,
  UserRights,
  UserLevelDefaultRights,
  UserInfo,
  LoginTime,
} from './entities';
import { JwtStrategy, LocalStrategy } from './strategies';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { TwoFaService } from './twofa/twofa.service';
import { TwoFaController } from './twofa/twofa.controller';
import { AuthCodeGuard } from './twofa/require-auth-code';

// The modern `users` table (the old `User` entity) has been retired —
// usermaster is now the single source of truth for user management. The
// `User` class itself still exists (see entities/user.entity.ts) purely as
// an in-memory shape for guards/strategies/UserRole+UserPermission enums; it
// is intentionally no longer registered with TypeORM here.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserMaster,
      UserLevelMaster,
      MenuMaster,
      UserRights,
      UserLevelDefaultRights,
      UserInfo,
      LoginTime,
    ]),
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRES_IN', '1h'),
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController, TwoFaController],
  providers: [
    AuthService,
    TwoFaService,
    JwtStrategy,
    LocalStrategy,
    // C-2 fix: apply the JWT guard globally instead of opting in controller by
    // controller. Before this, only a handful of ~68 controllers used
    // @UseGuards(JwtAuthGuard), leaving a third of all endpoints reachable with
    // no Authorization header at all — some of them writing data. JwtAuthGuard
    // already reads the `@Public()` metadata, so routes that must stay open
    // (login, refresh, health, licence status/activate, client-log upload)
    // opt out explicitly instead of everything opting in.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // ES-116: runs after JwtAuthGuard (so req.user is set); only acts on @RequireAuthCode() endpoints.
    { provide: APP_GUARD, useClass: AuthCodeGuard },
  ],
  exports: [AuthService, TwoFaService, TypeOrmModule],
})
export class AuthModule {}
