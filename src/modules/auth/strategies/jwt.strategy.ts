import { Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as crypto from 'crypto';
import { User } from '../entities/user.entity';
import { UserMaster } from '../entities/user-master.entity';
import { mapUserMasterToUser } from '../utils';

export interface JwtPayload {
  sub: number;
  username: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) implements OnModuleInit {
  constructor(
    @InjectRepository(UserMaster)
    private userMasterRepository: Repository<UserMaster>,
    private configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
      passReqToCallback: true,
    });
  }

  // Create the revoked-token denylist table once at boot so the per-request
  // check below never races an app that has never had a logout yet.
  async onModuleInit(): Promise<void> {
    await this.userMasterRepository.query(`
      CREATE TABLE IF NOT EXISTS revoked_tokens (
        token_hash  VARCHAR(64) PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        revoked_at  TIMESTAMP DEFAULT NOW(),
        expires_at  TIMESTAMP NOT NULL
      )
    `);
  }

  async validate(req: any, payload: JwtPayload): Promise<User> {
    const { sub: userId } = payload;

    // C-1 fix: reject tokens revoked by /auth/logout instead of letting them
    // ride out their natural expiry.
    const rawToken = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
    if (rawToken) {
      const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const revoked = await this.userMasterRepository.query(
        `SELECT 1 FROM revoked_tokens WHERE token_hash = $1 AND expires_at > NOW()`,
        [hash],
      );
      if (revoked.length > 0) {
        throw new UnauthorizedException('Token has been revoked');
      }
    }

    const userMaster = await this.userMasterRepository.findOne({
      where: { userid: userId },
      relations: ['userLevel'],
    });

    if (!userMaster) {
      throw new UnauthorizedException('User not found or inactive');
    }

    if (userMaster.enableDisable !== 'E') {
      throw new UnauthorizedException('User account is disabled');
    }

    // BUG FIX: an admin's "force logout" (LogOut User screen) used to only
    // flip loginStatus for display — this token would keep validating fine
    // until its natural expiry. Reject any token issued before the most
    // recent force-logout so it actually ends the session immediately.
    if (userMaster.forceLogoutAt && payload.iat) {
      const issuedAtMs = payload.iat * 1000;
      if (issuedAtMs < userMaster.forceLogoutAt.getTime()) {
        throw new UnauthorizedException('Session was terminated by an administrator');
      }
    }

    // BUG FIX: this used to duplicate mapUserMasterToUser's logic inline, and
    // had drifted — missing the MANAGE_SYSTEM_CONFIG/DAY_END_OPERATIONS/
    // PERFORM_BACKUP grants the other copy had. Since this function (not the
    // one in auth.service.ts) governs req.user on every authenticated
    // request, that meant every admin request potentially missed those
    // permissions, not just login. Now a single shared function.
    return mapUserMasterToUser(userMaster);
  }
}
