import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
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
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, LocalStrategy],
  exports: [AuthService, TypeOrmModule],
})
export class AuthModule {}
