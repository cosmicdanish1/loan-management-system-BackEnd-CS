import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { generateSecret } from '../../auth/twofa/totp.util';
import { MobileAuditService } from '../audit/mobile-audit.service';
import { MOBILE_DS } from '../mobile.constants';
import { ClientCtx, SessionTokens } from './access.types';
import { MemberDirectoryService } from './member-directory.service';
import { MobileCryptoService, formatCode, newActivationCode, normalizeCode, sha256, weakMpinReason } from './mobile-crypto';
import { SessionService } from './session.service';
import * as bcrypt from 'bcrypt';

export const MAX_TRUSTED_PHONES = 1; // a new activation signs out the previous phone (PRD 9.3)
const CODE_VALID_HOURS = 24;
const MAX_CODE_ATTEMPTS = 5;
const MAX_REQUESTS_PER_DAY = 3;
const TICKET_TYPE = 'activation';

export interface ActivationRequestInput {
  mbno: string;
  dob: string; // YYYY-MM-DD
  panLast4: string;
  phoneLast4: string;
}

export interface CompleteInput {
  ticket: string;
  mpin: string;
  deviceId: string;
  platform?: string;
  model?: string;
  osVersion?: string;
  appVersion?: string;
  consent?: { termsVersion?: number; privacyVersion?: number };
}

const GENERIC_INVALID = {
  statusCode: 401,
  code: 'INVALID_ACTIVATION',
  message: 'The member number or code is not correct, or the code has expired. Ask the society for a new code.',
};

/** First-time activation without SMS: staff codes and activation requests (PRD 9.1, ES-384). */
@Injectable()
export class ActivationService {
  constructor(
    @InjectDataSource(MOBILE_DS) private readonly ds: DataSource,
    private readonly directory: MemberDirectoryService,
    private readonly crypto: MobileCryptoService,
    private readonly sessions: SessionService,
    private readonly jwt: JwtService,
    private readonly audit: MobileAuditService,
  ) {}

  // ───────────── activation request (member side) ─────────────

  /**
   * A member who cannot visit the office sends identity answers. NOTHING is activated: staff compare the answers, call the
   * member back on the registered number and only then give a code. The reply is always the same, so this route cannot be
   * used to find out which member numbers exist.
   */
  async submitRequest(input: ActivationRequestInput, ctx: ClientCtx): Promise<{ received: true; message: string }> {
    const reply = {
      received: true as const,
      message: 'Your request was received. The society will call you back on your registered number.',
    };
    const member = await this.directory.getMember(input.mbno);
    if (!member || !member.isActive) {
      await this.audit.log({ event: 'ACTIVATION_REQUEST', result: 'IGNORED', mbno: null, ...ctx, detail: { reason: 'unknown_or_inactive' } });
      return reply;
    }
    const acct: any[] = await this.ds.query(`SELECT status FROM mobile_account WHERE mbno = $1`, [member.mbno]);
    if (acct[0]?.status === 'BLOCKED') {
      await this.audit.log({ event: 'ACTIVATION_REQUEST', result: 'IGNORED', mbno: member.mbno, ...ctx, detail: { reason: 'blocked' } });
      return reply;
    }
    const today: Array<{ n: string }> = await this.ds.query(
      `SELECT count(*)::text AS n FROM mobile_activation_request WHERE mbno = $1 AND created_at > now() - interval '24 hours'`,
      [member.mbno],
    );
    if (Number(today[0].n) >= MAX_REQUESTS_PER_DAY) {
      await this.audit.log({ event: 'ACTIVATION_REQUEST', result: 'IGNORED', mbno: member.mbno, ...ctx, detail: { reason: 'daily_limit' } });
      return reply;
    }

    const phone = await this.directory.phoneQuality(member.phone10);
    const match = {
      dob: member.dob !== null && member.dob === input.dob,
      pan: member.panLast4 !== null && member.panLast4 === input.panLast4.toUpperCase(),
      phone: member.phone10 !== null && member.phone10.endsWith(input.phoneLast4),
      phoneStatus: phone.status, // staff only call back when this is OK
      phoneSharedCount: phone.sharedCount,
    };
    const answersHash = this.crypto.keyedHash([member.mbno, input.dob, input.panLast4.toUpperCase(), input.phoneLast4].join('|'));

    await this.ds.query(
      `INSERT INTO mobile_activation_request (mbno, answers_hash, match_result, device_id_hash, ip)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [member.mbno, answersHash, JSON.stringify(match), ctx.deviceId ? sha256(ctx.deviceId) : null, ctx.ip ?? null],
    );
    // Show "request pending" in the Control Center, but never downgrade an ACTIVE account.
    await this.ds.query(
      `INSERT INTO mobile_account (mbno, status) VALUES ($1, 'REQUEST_PENDING')
       ON CONFLICT (mbno) DO UPDATE SET status = 'REQUEST_PENDING', updated_at = now()
        WHERE mobile_account.status IN ('NOT_ACTIVATED', 'DEACTIVATED')`,
      [member.mbno],
    );
    await this.audit.log({ event: 'ACTIVATION_REQUEST', result: 'OK', mbno: member.mbno, ...ctx, detail: { dob: match.dob, pan: match.pan, phone: match.phone, phoneStatus: phone.status } });
    return reply;
  }

  // ───────────── activation code (staff side) ─────────────

  /** Staff issue a one-time code. Returns the code ONCE; only a keyed hash is stored. Older unused codes stop working. */
  async issueCode(mbno: string, staffName: string): Promise<{ code: string; display: string; expiresAt: string; memberName: string }> {
    const member = await this.directory.getMember(mbno);
    if (!member) throw new BadRequestException('Member not found');
    if (!member.isActive) throw new BadRequestException('This member is inactive');
    const acct: any[] = await this.ds.query(`SELECT status FROM mobile_account WHERE mbno = $1`, [member.mbno]);
    if (acct[0]?.status === 'BLOCKED') throw new ForbiddenException('Mobile access is blocked for this member. Unblock it first.');

    const code = newActivationCode();
    const rows: any[] = await this.ds.transaction(async (m) => {
      await m.query(`UPDATE mobile_activation_code SET burned = true WHERE mbno = $1 AND used_at IS NULL AND NOT burned`, [member.mbno]);
      await m.query(`INSERT INTO mobile_account (mbno) VALUES ($1) ON CONFLICT (mbno) DO NOTHING`, [member.mbno]);
      return m.query(
        `INSERT INTO mobile_activation_code (mbno, code_hash, issued_by, expires_at)
         VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval) RETURNING expires_at`,
        [member.mbno, this.crypto.keyedHash(code), staffName.slice(0, 100), String(CODE_VALID_HOURS)],
      );
    });
    await this.audit.log({ event: 'ACTIVATION_CODE_ISSUED', result: 'OK', mbno: member.mbno, detail: { issuedBy: staffName } });
    return { code, display: formatCode(code), expiresAt: new Date(rows[0].expires_at).toISOString(), memberName: member.fullName };
  }

  // ───────────── activation (member side) ─────────────

  /** Step 1: member number + code. Returns a short-lived ticket; the code is only marked used when the MPIN is set. */
  async activate(input: { mbno: string; code: string; deviceId: string }, ctx: ClientCtx): Promise<{ ticket: string; expiresIn: number }> {
    const fail = async (reason: string, mbno: string | null): Promise<never> => {
      await this.audit.log({ event: 'ACTIVATE', result: 'FAIL', mbno, ...ctx, detail: { reason } });
      throw new UnauthorizedException(GENERIC_INVALID);
    };
    const member = await this.directory.getMember(input.mbno);
    if (!member || !member.isActive) return fail('unknown_or_inactive', null);

    const rows: any[] = await this.ds.query(
      `SELECT id, code_hash, wrong_attempts, expires_at < now() AS expired
         FROM mobile_activation_code
        WHERE mbno = $1 AND used_at IS NULL AND NOT burned
        ORDER BY issued_at DESC LIMIT 1`,
      [member.mbno],
    );
    if (!rows.length || rows[0].expired) return fail('no_valid_code', member.mbno);

    const ok = this.crypto.safeEqualHex(this.crypto.keyedHash(normalizeCode(input.code)), rows[0].code_hash);
    if (!ok) {
      const attempts = Number(rows[0].wrong_attempts) + 1;
      await this.ds.query(`UPDATE mobile_activation_code SET wrong_attempts = $2, burned = $3 WHERE id = $1`, [rows[0].id, attempts, attempts >= MAX_CODE_ATTEMPTS]);
      return fail(attempts >= MAX_CODE_ATTEMPTS ? 'code_burned' : 'wrong_code', member.mbno);
    }
    const acct: any[] = await this.ds.query(`SELECT status FROM mobile_account WHERE mbno = $1`, [member.mbno]);
    if (acct[0]?.status === 'BLOCKED') return fail('blocked', member.mbno);

    const ticket = await this.jwt.signAsync({ typ: TICKET_TYPE, mbno: member.mbno, cid: Number(rows[0].id), dh: sha256(input.deviceId) }, { expiresIn: '10m' });
    await this.audit.log({ event: 'ACTIVATE', result: 'OK', mbno: member.mbno, ...ctx });
    return { ticket, expiresIn: 600 };
  }

  /** Step 2: set the MPIN, accept Terms, bind the phone. Creates the App Code secret and the first session. */
  async complete(input: CompleteInput, ctx: ClientCtx): Promise<SessionTokens & { appCodeSecret: string; mbno: string; memberName: string }> {
    let claims: any;
    try {
      claims = await this.jwt.verifyAsync(input.ticket);
    } catch {
      throw new UnauthorizedException(GENERIC_INVALID);
    }
    if (claims?.typ !== TICKET_TYPE || claims.dh !== sha256(input.deviceId)) throw new UnauthorizedException(GENERIC_INVALID);

    const member = await this.directory.getMember(claims.mbno);
    if (!member || !member.isActive) throw new UnauthorizedException(GENERIC_INVALID);
    const weak = weakMpinReason(input.mpin, member.dob);
    if (weak) throw new BadRequestException({ statusCode: 400, code: 'MPIN_TOO_WEAK', message: weak });

    const mpinHash = await bcrypt.hash(input.mpin, 10);
    const appSecret = generateSecret();
    const deviceHash = sha256(input.deviceId);

    const result = await this.ds.transaction(async (m) => {
      // Take the code (once). If somebody else already used it, stop.
      const code: any[] = await m.query(
        `UPDATE mobile_activation_code SET used_at = now()
          WHERE id = $1 AND mbno = $2 AND used_at IS NULL AND NOT burned AND expires_at > now() RETURNING id`,
        [claims.cid, member.mbno],
      );
      const taken = Array.isArray(code[0]) ? code[0] : code;
      if (!taken.length) throw new UnauthorizedException(GENERIC_INVALID);

      const acct: any[] = await m.query(`SELECT status FROM mobile_account WHERE mbno = $1 FOR UPDATE`, [member.mbno]);
      if (acct[0]?.status === 'BLOCKED') throw new ForbiddenException('Mobile access is blocked for this member');

      await m.query(
        `INSERT INTO mobile_account (mbno, status, mpin_hash, failed_attempts, locked_until, activated_at, blocked_reason, blocked_by)
         VALUES ($1, 'ACTIVE', $2, 0, NULL, now(), NULL, NULL)
         ON CONFLICT (mbno) DO UPDATE SET status = 'ACTIVE', mpin_hash = $2, failed_attempts = 0, locked_until = NULL,
                activated_at = now(), blocked_reason = NULL, blocked_by = NULL, updated_at = now()`,
        [member.mbno, mpinHash],
      );

      // A new phone signs out the old one(s): revoke every other device and its sessions.
      const others: any[] = await m.query(
        `UPDATE mobile_device SET revoked = true, revoked_at = now(), revoked_by = 'new activation'
          WHERE mbno = $1 AND device_id_hash <> $2 AND NOT revoked RETURNING id`,
        [member.mbno, deviceHash],
      );
      for (const d of Array.isArray(others[0]) ? others[0] : others) await this.sessions.revokeDevice(Number(d.id), m);

      const dev: any[] = await m.query(
        `INSERT INTO mobile_device (mbno, device_id_hash, platform, model, os_version, app_version, appcode_secret_enc, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (mbno, device_id_hash) DO UPDATE SET revoked = false, revoked_at = NULL, revoked_by = NULL,
                platform = $3, model = $4, os_version = $5, app_version = $6, appcode_secret_enc = $7, last_seen = now()
         RETURNING id`,
        [member.mbno, deviceHash, input.platform ?? null, input.model ?? null, input.osVersion ?? null, input.appVersion ?? null, this.crypto.encrypt(appSecret)],
      );
      const deviceDbId = Number(dev[0].id);

      for (const [type, version] of [['TERMS', input.consent?.termsVersion], ['PRIVACY', input.consent?.privacyVersion]] as const) {
        if (version) {
          await m.query(
            `INSERT INTO mobile_consent (mbno, doc_type, doc_version, device_id_hash, app_version, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
            [member.mbno, type, version, deviceHash, input.appVersion ?? null, ctx.ip ?? null],
          );
        }
      }
      return this.sessions.start(member.mbno, deviceDbId, m);
    });

    await this.audit.log({ event: 'ACTIVATION_COMPLETE', result: 'OK', mbno: member.mbno, ...ctx });
    return { ...result, appCodeSecret: appSecret, mbno: member.mbno, memberName: member.fullName };
  }
}
