import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { MobileAuditService } from '../audit/mobile-audit.service';
import { MOBILE_DS } from '../mobile.constants';
import { ClientCtx, SessionTokens } from './access.types';
import { sha256 } from './mobile-crypto';
import { SessionService } from './session.service';

export const MAX_MPIN_TRIES = 5;
/** Short waits after the 3rd and 4th wrong MPIN (seconds); the 5th wrong MPIN locks the account until staff unlock it. */
const delayAfter = (attempts: number): number => (attempts === 3 ? 30 : attempts === 4 ? 60 : 0);

// bcrypt hash of a random value: compared against when the member/phone is unknown so timing does not reveal which is wrong.
const DUMMY_HASH = '$2b$10$7EqJtq98hPqEX7fNZaFWoOHiJZ1T9Zk3rY1hXh1nQy8mQh0vYk3dK';

const invalid = () =>
  new UnauthorizedException({ statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'Member number or MPIN is not correct' });

/** Daily sign-in with member number + MPIN, refresh and sign-out (ES-384). */
@Injectable()
export class MemberAuthService {
  constructor(
    @InjectDataSource(MOBILE_DS) private readonly ds: DataSource,
    private readonly sessions: SessionService,
    private readonly audit: MobileAuditService,
  ) {}

  async login(input: { mbno: string; mpin: string; deviceId: string }, ctx: ClientCtx): Promise<SessionTokens & { mbno: string }> {
    const deviceHash = sha256(input.deviceId);
    const rows: any[] = await this.ds.query(
      `SELECT a.mbno::text AS mbno, a.status, a.mpin_hash, a.failed_attempts,
              GREATEST(0, EXTRACT(EPOCH FROM (a.locked_until - now())))::int AS wait_seconds,
              d.id AS device_id, d.revoked
         FROM mobile_account a
         LEFT JOIN mobile_device d ON d.mbno = a.mbno AND d.device_id_hash = $2
        WHERE a.mbno = $1`,
      [/^\d{1,18}$/.test(input.mbno) ? input.mbno : '0', deviceHash],
    );
    const a = rows[0];

    if (!a || !a.device_id || a.revoked || a.status === 'NOT_ACTIVATED' || a.status === 'REQUEST_PENDING' || a.status === 'DEACTIVATED') {
      await bcrypt.compare(input.mpin, DUMMY_HASH).catch(() => false);
      await this.audit.log({ event: 'LOGIN', result: 'FAIL', mbno: a?.mbno ?? null, ...ctx, detail: { reason: !a ? 'no_account' : !a.device_id || a.revoked ? 'unknown_phone' : String(a.status).toLowerCase() } });
      throw invalid();
    }
    if (a.status === 'BLOCKED') {
      await this.audit.log({ event: 'LOGIN', result: 'FAIL', mbno: a.mbno, ...ctx, detail: { reason: 'blocked' } });
      throw new HttpException({ statusCode: 403, code: 'ACCESS_BLOCKED', message: 'Your mobile access is blocked. Please contact the society.' }, HttpStatus.FORBIDDEN);
    }
    if (a.status === 'LOCKED') {
      await this.audit.log({ event: 'LOGIN', result: 'FAIL', mbno: a.mbno, ...ctx, detail: { reason: 'locked' } });
      throw new HttpException({ statusCode: 423, code: 'MPIN_LOCKED', message: 'Too many wrong MPIN attempts. Please contact the society to unlock.' }, 423);
    }
    if (a.wait_seconds > 0) {
      throw new HttpException(
        { statusCode: 429, code: 'MPIN_DELAY', message: `Please wait ${a.wait_seconds} seconds before trying again`, retryAfterSeconds: a.wait_seconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ok = await bcrypt.compare(input.mpin, a.mpin_hash || DUMMY_HASH);
    if (!ok) {
      const attempts = Number(a.failed_attempts) + 1;
      const lock = attempts >= MAX_MPIN_TRIES;
      const delay = delayAfter(attempts);
      await this.ds.query(
        `UPDATE mobile_account
            SET failed_attempts = $2,
                status = CASE WHEN $3 THEN 'LOCKED' ELSE status END,
                locked_until = CASE WHEN $4 > 0 THEN now() + ($4 || ' seconds')::interval ELSE locked_until END,
                updated_at = now()
          WHERE mbno = $1`,
        [a.mbno, attempts, lock, delay],
      );
      await this.audit.log({ event: lock ? 'MPIN_LOCKED' : 'LOGIN', result: 'FAIL', mbno: a.mbno, ...ctx, detail: { reason: 'wrong_mpin', attempts } });
      if (lock) {
        throw new HttpException({ statusCode: 423, code: 'MPIN_LOCKED', message: 'Too many wrong MPIN attempts. Please contact the society to unlock.' }, 423);
      }
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Member number or MPIN is not correct',
        attemptsLeft: MAX_MPIN_TRIES - attempts,
      });
    }

    await this.ds.query(`UPDATE mobile_account SET failed_attempts = 0, locked_until = NULL WHERE mbno = $1`, [a.mbno]);
    await this.ds.query(`UPDATE mobile_device SET last_seen = now(), app_version = COALESCE($2, app_version), platform = COALESCE($3, platform) WHERE id = $1`, [a.device_id, ctx.appVersion ?? null, ctx.platform ?? null]);
    const tokens = await this.sessions.start(a.mbno, Number(a.device_id));
    await this.audit.log({ event: 'LOGIN', result: 'OK', mbno: a.mbno, ...ctx });
    return { ...tokens, mbno: a.mbno };
  }

  async refresh(input: { refreshToken: string; deviceId: string }, ctx: ClientCtx): Promise<SessionTokens> {
    try {
      const r = await this.sessions.rotate(input.refreshToken, sha256(input.deviceId));
      await this.ds.query(`UPDATE mobile_device SET last_seen = now() WHERE id = $1`, [r.deviceId]);
      return { accessToken: r.accessToken, refreshToken: r.refreshToken, expiresIn: r.expiresIn };
    } catch (e) {
      const code = (e as any)?.getResponse?.()?.code;
      await this.audit.log({ event: code === 'REFRESH_REUSED' ? 'REFRESH_REUSE' : 'REFRESH', result: 'FAIL', ...ctx, detail: { code } });
      throw e;
    }
  }

  async logout(input: { refreshToken?: string; deviceId: string }, member: { mbno: string; deviceId: number }, ctx: ClientCtx): Promise<void> {
    if (input.refreshToken) await this.sessions.revokeByRefreshToken(input.refreshToken, sha256(input.deviceId));
    else await this.sessions.revokeDevice(member.deviceId);
    await this.audit.log({ event: 'LOGOUT', result: 'OK', mbno: member.mbno, ...ctx });
  }
}
