import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import * as crypto from 'crypto';
import { MemberTokenService } from '../auth/member-token.service';
import { MOBILE_DS } from '../mobile.constants';
import { SessionTokens } from './access.types';
import { MobileCryptoService, sha256 } from './mobile-crypto';

type Q = Pick<DataSource | EntityManager, 'query'>;

/**
 * Refresh-token sessions (PRD 9.1): a refresh token is random, only its SHA-256 is stored, it rotates on every use and
 * a token that is used twice kills its whole family (theft detection). Absolute limit 90 days, then staff must re-activate.
 */
@Injectable()
export class SessionService {
  private readonly refreshDays: number;
  private readonly absoluteDays: number;

  constructor(
    @InjectDataSource(MOBILE_DS) private readonly ds: DataSource,
    private readonly tokens: MemberTokenService,
    private readonly jwt: JwtService,
    private readonly crypto: MobileCryptoService,
    config: ConfigService,
  ) {
    this.refreshDays = Number(config.get('MOBILE_REFRESH_TTL_DAYS', 30));
    this.absoluteDays = Number(config.get('MOBILE_SESSION_MAX_DAYS', 90));
  }

  /** Starts a new session family for a phone. `q` lets activation do this inside its transaction. */
  async start(mbno: string, deviceDbId: number, q: Q = this.ds): Promise<SessionTokens> {
    const family = crypto.randomUUID();
    return this.issue(mbno, deviceDbId, family, q);
  }

  private async issue(mbno: string, deviceDbId: number, family: string, q: Q): Promise<SessionTokens> {
    const refreshToken = this.crypto.newRefreshToken();
    await q.query(
      `INSERT INTO mobile_session (mbno, device_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval)`,
      [mbno, deviceDbId, family, sha256(refreshToken), String(this.refreshDays)],
    );
    const accessToken = await this.tokens.signAccess(mbno, deviceDbId);
    const decoded: any = this.jwt.decode(accessToken);
    return { accessToken, refreshToken, expiresIn: decoded?.exp && decoded?.iat ? decoded.exp - decoded.iat : 900 };
  }

  /**
   * Exchanges a refresh token for a new pair. Returns null reason strings through UnauthorizedException with a code:
   * REFRESH_INVALID (unknown / expired / wrong phone), REFRESH_REUSED (family killed), SESSION_EXPIRED (90-day limit).
   */
  async rotate(refreshToken: string, deviceIdHash: string): Promise<SessionTokens & { mbno: string; deviceId: number; familyId: string }> {
    const rows: any[] = await this.ds.query(
      `SELECT s.id, s.mbno::text AS mbno, s.device_id, s.family_id, s.used_at, s.revoked_at, s.expires_at < now() AS expired,
              d.device_id_hash, d.revoked AS device_revoked, a.status,
              (SELECT min(created_at) FROM mobile_session f WHERE f.family_id = s.family_id) < now() - ($2 || ' days')::interval AS too_old
         FROM mobile_session s
         JOIN mobile_device d ON d.id = s.device_id
         LEFT JOIN mobile_account a ON a.mbno = s.mbno
        WHERE s.token_hash = $1`,
      [sha256(refreshToken || ''), String(this.absoluteDays)],
    );
    const fail = (code: string): never => {
      throw new UnauthorizedException({ statusCode: 401, code, message: 'Please sign in again' });
    };
    if (!rows.length) return fail('REFRESH_INVALID');
    const s = rows[0];
    if (s.device_id_hash !== deviceIdHash) return fail('REFRESH_INVALID');

    if (s.used_at) {
      // A rotated (already used) token came back: someone copied it. Kill the whole family.
      await this.revokeFamily(s.family_id);
      return fail('REFRESH_REUSED');
    }
    if (s.revoked_at) return fail('REFRESH_INVALID'); // signed out, or the family was already killed
    if (s.expired || s.device_revoked || s.status !== 'ACTIVE') return fail('REFRESH_INVALID');
    if (s.too_old) {
      await this.revokeFamily(s.family_id);
      return fail('SESSION_EXPIRED');
    }

    // Claim the token atomically so two simultaneous refreshes cannot both succeed.
    const claimed: any[] = await this.ds.query(`UPDATE mobile_session SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`, [s.id]);
    const rowsClaimed = Array.isArray(claimed[0]) ? claimed[0] : claimed;
    if (!rowsClaimed.length) {
      await this.revokeFamily(s.family_id);
      return fail('REFRESH_REUSED');
    }
    const next = await this.issue(s.mbno, Number(s.device_id), s.family_id, this.ds);
    return { ...next, mbno: s.mbno, deviceId: Number(s.device_id), familyId: s.family_id };
  }

  async revokeFamily(familyId: string, q: Q = this.ds): Promise<void> {
    await q.query(`UPDATE mobile_session SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [familyId]);
  }

  async revokeDevice(deviceDbId: number, q: Q = this.ds): Promise<void> {
    await q.query(`UPDATE mobile_session SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL`, [deviceDbId]);
  }

  async revokeAllForMember(mbno: string, q: Q = this.ds): Promise<void> {
    await q.query(`UPDATE mobile_session SET revoked_at = now() WHERE mbno = $1 AND revoked_at IS NULL`, [mbno]);
  }

  async revokeByRefreshToken(refreshToken: string, deviceIdHash: string): Promise<void> {
    const rows: any[] = await this.ds.query(
      `SELECT s.family_id FROM mobile_session s JOIN mobile_device d ON d.id = s.device_id
        WHERE s.token_hash = $1 AND d.device_id_hash = $2`,
      [sha256(refreshToken || ''), deviceIdHash],
    );
    if (rows.length) await this.revokeFamily(rows[0].family_id);
  }
}
