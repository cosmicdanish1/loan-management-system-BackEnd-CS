import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { MEMBER_JWT_STRATEGY, MEMBER_TOKEN_AUDIENCE, MEMBER_TOKEN_TYPE, MOBILE_DS } from '../mobile.constants';
import { resolveMemberSecret } from './member-secret';
import { MemberTokenPayload } from './member-token.service';

/** What the guard puts on `req.user` for a signed-in member. Only the token decides who the member is. */
export interface CurrentMemberInfo {
  kind: 'member';
  mbno: string;
  deviceId: number;
}

@Injectable()
export class MemberJwtStrategy extends PassportStrategy(Strategy, MEMBER_JWT_STRATEGY) {
  constructor(
    config: ConfigService,
    @InjectDataSource(MOBILE_DS) private readonly ds: DataSource,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: resolveMemberSecret(config),
    });
  }

  async validate(payload: Partial<MemberTokenPayload>): Promise<CurrentMemberInfo> {
    // A staff token has no typ/aud (and is signed with a different secret): refuse anything that is not a member token.
    if (payload?.typ !== MEMBER_TOKEN_TYPE || payload?.aud !== MEMBER_TOKEN_AUDIENCE || !payload.mbno || !payload.did) {
      throw new UnauthorizedException('Invalid member token');
    }

    // Live checks on every request: access must be ACTIVE and the phone must still be trusted (not revoked).
    const rows: Array<{ status: string; revoked: boolean }> = await this.ds.query(
      `SELECT a.status, d.revoked
         FROM mobile_account a
         JOIN mobile_device d ON d.mbno = a.mbno AND d.id = $2
        WHERE a.mbno = $1`,
      [payload.mbno, payload.did],
    );
    if (!rows.length || rows[0].status !== 'ACTIVE' || rows[0].revoked) {
      throw new UnauthorizedException('Mobile access is not active for this phone');
    }

    return { kind: 'member', mbno: String(payload.mbno), deviceId: Number(payload.did) };
  }
}
