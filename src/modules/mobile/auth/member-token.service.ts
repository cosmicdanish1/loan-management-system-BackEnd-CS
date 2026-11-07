import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MEMBER_TOKEN_AUDIENCE, MEMBER_TOKEN_TYPE } from '../mobile.constants';

export interface MemberTokenPayload {
  typ: typeof MEMBER_TOKEN_TYPE;
  aud: typeof MEMBER_TOKEN_AUDIENCE;
  /** member number as a string (numeric(18,0) in the database) */
  mbno: string;
  /** mobile_device.id of the bound phone */
  did: number;
  iat?: number;
  exp?: number;
}

/** Signs member access tokens (15 minutes). The login / refresh flow that uses it comes with ES-384. */
@Injectable()
export class MemberTokenService {
  constructor(private readonly jwt: JwtService) {}

  signAccess(mbno: string, deviceId: number): Promise<string> {
    const payload: Omit<MemberTokenPayload, 'iat' | 'exp'> = {
      typ: MEMBER_TOKEN_TYPE,
      aud: MEMBER_TOKEN_AUDIENCE,
      mbno: String(mbno),
      did: deviceId,
    };
    return this.jwt.signAsync(payload);
  }
}
