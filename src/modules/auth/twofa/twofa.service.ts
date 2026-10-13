import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import * as QRCode from 'qrcode';
import { UserMaster } from '../entities';
import { mapUserMasterToUser } from '../utils';
import { generateSecret, otpauthUrl, verifyTotp } from './totp.util';

export type TwoFaPolicy = 'off' | 'optional' | 'roles' | 'all';

export interface TwoFaSettings {
  policy: TwoFaPolicy;
  /** usermaster.userlevelid values, used when policy === 'roles' */
  requiredLevelIds: number[];
  graceDays: number;
  /** 0 = "remember this device" is off */
  rememberDays: number;
  recoveryCount: number;
  maxAttempts: number;
  lockoutMinutes: number;
  issuer: string;
  /** ES-124: may an approver approve an action they are performing themselves? default no */
  approverCanApproveOwn: boolean;
}

const DEFAULTS: TwoFaSettings = {
  policy: 'optional',
  requiredLevelIds: [],
  graceDays: 7,
  rememberDays: 0,
  recoveryCount: 10,
  maxAttempts: 5,
  lockoutMinutes: 15,
  issuer: 'EMP Society',
  approverCanApproveOwn: false,
};

const KEY_PREFIX = 'twofa.';
const CHALLENGE_TTL = '5m';
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export type GateMode = 'none' | 'verify' | 'enrol';
export interface Gate {
  mode: GateMode;
  /** policy requires 2FA for this user and they have not enrolled yet (inside grace) */
  graceDaysLeft: number | null;
  required: boolean;
  enrolled: boolean;
  trusted: boolean;
}

/**
 * Actions that can demand the performer's own authenticator code (ES-116).
 * Only actions whose backend endpoint is actually wired to the guard are listed,
 * so a switch in the settings window always does something.
 */
export const GUARD_ACTIONS: Record<string, { label: string; hint: string }> = {
  early_closure: { label: 'Early Loan Closure', hint: 'Closing a whole loan before its term' },
  reagreement_pass: { label: 'Loan Re-agreement (Pass)', hint: 'Passing a restructure voucher in Pass Transactions' },
  pass_transactions: { label: 'Pass Transactions (all vouchers)', hint: 'Final posting of any voucher' },
  reverse_transactions: { label: 'Reverse Transactions', hint: 'Reversing a posted voucher' },
};

export interface GuardConfig {
  enabled: boolean;
}

@Injectable()
export class TwoFaService implements OnModuleInit {
  private readonly logger = new Logger(TwoFaService.name);

  constructor(
    @InjectRepository(UserMaster) private readonly users: Repository<UserMaster>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------- schema

  async onModuleInit(): Promise<void> {
    const q = (s: string) => this.users.query(s);
    await q(`ALTER TABLE usermaster ADD COLUMN IF NOT EXISTS totp_secret_enc text`);
    await q(`ALTER TABLE usermaster ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false`);
    await q(`ALTER TABLE usermaster ADD COLUMN IF NOT EXISTS totp_last_step bigint`);
    await q(`ALTER TABLE usermaster ADD COLUMN IF NOT EXISTS totp_enrolled_at timestamp`);
    await q(`ALTER TABLE usermaster ADD COLUMN IF NOT EXISTS totp_failed_count integer NOT NULL DEFAULT 0`);
    await q(`ALTER TABLE usermaster ADD COLUMN IF NOT EXISTS totp_locked_until timestamp`);
    await q(`CREATE TABLE IF NOT EXISTS user_recovery_codes (
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      code_hash varchar(80) NOT NULL,
      used_at timestamp,
      created_at timestamp NOT NULL DEFAULT now()
    )`);
    await q(`CREATE INDEX IF NOT EXISTS idx_user_recovery_codes_user ON user_recovery_codes (user_id)`);
    await q(`CREATE TABLE IF NOT EXISTS trusted_devices (
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      token_hash varchar(64) NOT NULL UNIQUE,
      expires_at timestamp NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS twofa_audit (
      id serial PRIMARY KEY,
      user_id integer,
      actor varchar(60),
      event varchar(40) NOT NULL,
      detail text,
      at timestamp NOT NULL DEFAULT now()
    )`);
    // ES-124 retired the shared approval QR of ES-116: remove its leftovers.
    await q(`DELETE FROM system_settings WHERE "key" LIKE 'twofa.approval.%'`);
    await q(`DELETE FROM user_recovery_codes WHERE user_id = 0`);
    // Menu row for the "Two-Factor Authentication" settings window (menu-action-map.ts, id 242),
    // so Configure UserLevel Default Rights can list it. Admin levels bypass rights anyway.
    await q(`INSERT INTO menumaster (menuid, menuname, menudesc, visibleflag)
             SELECT 242, 'Two-Factor Authentication', 'Two-Factor Authentication', 'Y'
              WHERE NOT EXISTS (SELECT 1 FROM menumaster WHERE menuid = 242)`)
      .catch((e: any) => this.logger.warn(`menumaster seed for 2FA skipped: ${e.message}`));
    // system_settings is created by TypeORM (SystemSetting entity); make sure it
    // exists even on a database that has never loaded the utilities module.
    await q(`CREATE TABLE IF NOT EXISTS system_settings (
      "key" varchar PRIMARY KEY, "value" text,
      "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now()
    )`);
  }

  private async q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const r: any = await this.users.query(sql, params);
    // TypeORM returns [rows, rowCount] for UPDATE/DELETE on postgres.
    return Array.isArray(r) && r.length === 2 && Array.isArray(r[0]) && typeof r[1] === 'number' ? r[0] : r;
  }

  async audit(userId: number | null, actor: string, event: string, detail = ''): Promise<void> {
    try {
      await this.users.query(
        `INSERT INTO twofa_audit (user_id, actor, event, detail) VALUES ($1,$2,$3,$4)`,
        [userId, actor, event, detail.slice(0, 500)],
      );
    } catch (e: any) {
      this.logger.warn(`2FA audit write failed: ${e.message}`);
    }
  }

  // -------------------------------------------------------------- settings

  async getSettings(): Promise<TwoFaSettings> {
    const rows = await this.q<{ key: string; value: string }>(
      `SELECT "key", "value" FROM system_settings WHERE "key" LIKE $1`,
      [`${KEY_PREFIX}%`],
    );
    const m = new Map(rows.map((r) => [r.key.slice(KEY_PREFIX.length), r.value]));
    const num = (k: string, d: number) => {
      const v = Number(m.get(k));
      return m.has(k) && Number.isFinite(v) ? v : d;
    };
    const policy = (m.get('policy') as TwoFaPolicy) || DEFAULTS.policy;
    return {
      policy: ['off', 'optional', 'roles', 'all'].includes(policy) ? policy : DEFAULTS.policy,
      requiredLevelIds: (m.get('required_levels') || '')
        .split(',')
        .filter((s) => s.trim() !== '')
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n)),
      graceDays: num('grace_days', DEFAULTS.graceDays),
      rememberDays: num('remember_days', DEFAULTS.rememberDays),
      recoveryCount: num('recovery_count', DEFAULTS.recoveryCount),
      maxAttempts: num('max_attempts', DEFAULTS.maxAttempts),
      lockoutMinutes: num('lockout_minutes', DEFAULTS.lockoutMinutes),
      issuer: m.get('issuer') || DEFAULTS.issuer,
      approverCanApproveOwn: m.get('approver_self') === '1',
    };
  }

  private async setKey(key: string, value: string): Promise<void> {
    await this.users.query(
      `INSERT INTO system_settings ("key","value") VALUES ($1,$2)
       ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()`,
      [KEY_PREFIX + key, value],
    );
  }

  async saveSettings(patch: Partial<TwoFaSettings>, actor: string): Promise<TwoFaSettings> {
    const before = await this.getSettings();
    const clamp = (n: any, lo: number, hi: number, name: string) => {
      const v = Number(n);
      if (!Number.isInteger(v) || v < lo || v > hi) {
        throw new BadRequestException(`${name} must be a whole number between ${lo} and ${hi}`);
      }
      return v;
    };
    if (patch.policy !== undefined) {
      if (!['off', 'optional', 'roles', 'all'].includes(patch.policy)) {
        throw new BadRequestException('Invalid policy');
      }
      await this.setKey('policy', patch.policy);
    }
    if (patch.requiredLevelIds !== undefined) {
      const ids = (patch.requiredLevelIds || []).map((n) => clamp(n, 0, 32767, 'Role id'));
      await this.setKey('required_levels', ids.join(','));
    }
    if (patch.graceDays !== undefined) await this.setKey('grace_days', String(clamp(patch.graceDays, 0, 365, 'Grace period')));
    if (patch.rememberDays !== undefined) await this.setKey('remember_days', String(clamp(patch.rememberDays, 0, 365, 'Remember-device days')));
    if (patch.recoveryCount !== undefined) await this.setKey('recovery_count', String(clamp(patch.recoveryCount, 4, 20, 'Recovery codes')));
    if (patch.maxAttempts !== undefined) await this.setKey('max_attempts', String(clamp(patch.maxAttempts, 3, 20, 'Max failed attempts')));
    if (patch.lockoutMinutes !== undefined) await this.setKey('lockout_minutes', String(clamp(patch.lockoutMinutes, 1, 1440, 'Lockout minutes')));
    if (patch.approverCanApproveOwn !== undefined) await this.setKey('approver_self', patch.approverCanApproveOwn ? '1' : '0');
    if (patch.issuer !== undefined) {
      const issuer = String(patch.issuer).trim();
      if (!issuer || issuer.length > 40 || /[:]/.test(issuer)) {
        throw new BadRequestException('Issuer must be 1-40 characters and must not contain ":"');
      }
      await this.setKey('issuer', issuer);
    }
    const after = await this.getSettings();
    // The grace period counts from the moment 2FA becomes mandatory for someone.
    const mandatory = (s: TwoFaSettings) => s.policy === 'all' || (s.policy === 'roles' && s.requiredLevelIds.length > 0);
    const levelsChanged = before.requiredLevelIds.join() !== after.requiredLevelIds.join();
    if (mandatory(after) && (!mandatory(before) || before.policy !== after.policy || levelsChanged)) {
      await this.setKey('policy_since', new Date().toISOString());
    }
    await this.audit(null, actor, 'settings_changed', JSON.stringify(patch));
    return after;
  }

  private async graceEnd(s: TwoFaSettings): Promise<Date> {
    const rows = await this.q<{ value: string }>(`SELECT "value" FROM system_settings WHERE "key" = $1`, [KEY_PREFIX + 'policy_since']);
    const since = rows[0]?.value ? new Date(rows[0].value) : new Date();
    return new Date(since.getTime() + s.graceDays * 86400000);
  }

  // ------------------------------------------------------------ encryption

  private encKey(): Buffer {
    const k = this.config.get<string>('TOTP_ENC_KEY');
    if (k) return crypto.createHash('sha256').update(k).digest();
    // Fallback so the feature works out of the box; set TOTP_ENC_KEY in .env so
    // the secrets' key is independent of the JWT signing secret.
    return crypto.createHash('sha256').update('totp-enc:' + (this.config.get<string>('JWT_SECRET') || '')).digest();
  }

  private encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.encKey(), iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  private decrypt(blob: string): string {
    const raw = Buffer.from(blob.replace(/^v1:/, ''), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this.encKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }

  // ----------------------------------------------------------------- state

  private async row(userId: number) {
    const r = await this.q<any>(
      `SELECT userid, susername, userlevelid, totp_secret_enc, totp_enabled, totp_last_step,
              totp_enrolled_at, totp_failed_count, totp_locked_until
         FROM usermaster WHERE userid = $1`,
      [userId],
    );
    return r[0];
  }

  /** What should happen at login for this user, before any code is asked for. */
  async gate(userId: number, deviceToken?: string): Promise<Gate> {
    const [s, u] = await Promise.all([this.getSettings(), this.row(userId)]);
    if (!u) return { mode: 'none', graceDaysLeft: null, required: false, enrolled: false, trusted: false };
    const enrolled = !!u.totp_enabled;
    const required =
      s.policy === 'all' || (s.policy === 'roles' && s.requiredLevelIds.includes(Number(u.userlevelid)));
    if (s.policy === 'off') return { mode: 'none', graceDaysLeft: null, required: false, enrolled, trusted: false };

    if (enrolled) {
      const trusted = !!deviceToken && (await this.isTrusted(userId, deviceToken));
      return { mode: trusted ? 'none' : 'verify', graceDaysLeft: null, required, enrolled, trusted };
    }
    if (required) {
      const end = await this.graceEnd(s);
      const left = Math.ceil((end.getTime() - Date.now()) / 86400000);
      if (left > 0) return { mode: 'none', graceDaysLeft: left, required, enrolled, trusted: false };
      return { mode: 'enrol', graceDaysLeft: 0, required, enrolled, trusted: false };
    }
    return { mode: 'none', graceDaysLeft: null, required, enrolled, trusted: false };
  }

  async status(userId: number) {
    const [s, u] = await Promise.all([this.getSettings(), this.row(userId)]);
    if (!u) throw new UnauthorizedException('User not found');
    const g = await this.gate(userId);
    const remaining = u.totp_enabled
      ? Number((await this.q(`SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL`, [userId]))[0].n)
      : 0;
    return {
      available: s.policy !== 'off',
      enrolled: !!u.totp_enabled,
      enrolledAt: u.totp_enrolled_at,
      required: g.required,
      graceDaysLeft: g.graceDaysLeft,
      recoveryCodesRemaining: remaining,
      rememberDays: s.rememberDays,
      policy: s.policy,
    };
  }

  // ------------------------------------------------------ challenge tokens

  private challengeSecret(): string {
    return (this.config.get<string>('JWT_SECRET') || '') + ':2fa-challenge';
  }

  /** Short-lived, signed with a DIFFERENT secret so it can never act as an access token. */
  signChallenge(userId: number, mode: 'verify' | 'enrol'): string {
    return this.jwt.sign({ sub: userId, purpose: '2fa', mode }, { secret: this.challengeSecret(), expiresIn: CHALLENGE_TTL });
  }

  readChallenge(token: string, mode?: 'verify' | 'enrol'): number {
    try {
      const p: any = this.jwt.verify(token, { secret: this.challengeSecret() });
      if (p.purpose !== '2fa' || (mode && p.mode !== mode)) throw new Error('wrong challenge');
      return Number(p.sub);
    } catch {
      throw new UnauthorizedException('Sign-in step expired. Please sign in again.');
    }
  }

  // ------------------------------------------------------------ verifying

  private async registerFailure(userId: number, s: TwoFaSettings, why: string): Promise<never> {
    const r = await this.q<any>(
      `UPDATE usermaster SET totp_failed_count = totp_failed_count + 1 WHERE userid = $1 RETURNING totp_failed_count`,
      [userId],
    );
    const n = Number(r[0]?.totp_failed_count || 0);
    await this.audit(userId, 'system', 'verify_failed', why);
    if (n >= s.maxAttempts) {
      await this.users.query(
        `UPDATE usermaster SET totp_failed_count = 0, totp_locked_until = now() + ($2 || ' minutes')::interval WHERE userid = $1`,
        [userId, String(s.lockoutMinutes)],
      );
      await this.audit(userId, 'system', 'locked_out', `${s.lockoutMinutes} min`);
      throw new ForbiddenException(`Too many wrong codes. Try again in ${s.lockoutMinutes} minutes.`);
    }
    throw new UnauthorizedException('Invalid authentication code');
  }

  /**
   * Checks a live authenticator code (and, when allowed, a recovery code) for
   * `userId`. Throws on failure; resolves to which kind was used on success.
   * Also the entry point ES-116's sensitive-action guard calls (recovery off).
   */
  async verifyUserCode(userId: number, code: string, allowRecovery: boolean): Promise<'totp' | 'recovery'> {
    const s = await this.getSettings();
    const u = await this.row(userId);
    if (!u || !u.totp_enabled || !u.totp_secret_enc) throw new BadRequestException('Two-factor authentication is not set up for this user');
    if (u.totp_locked_until && new Date(u.totp_locked_until).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(u.totp_locked_until).getTime() - Date.now()) / 60000);
      throw new ForbiddenException(`Too many wrong codes. Try again in ${mins} minute(s).`);
    }
    const input = String(code || '').trim();
    if (!input) throw new BadRequestException('Enter the code');

    if (/^\d{6}$/.test(input.replace(/\s+/g, ''))) {
      const secret = this.decrypt(u.totp_secret_enc);
      const step = verifyTotp(secret, input);
      if (step !== null) {
        // Conditional update = atomic replay guard: only one request can claim a step.
        const claimed = await this.q(
          `UPDATE usermaster SET totp_last_step = $2, totp_failed_count = 0
            WHERE userid = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING userid`,
          [userId, step],
        );
        if (claimed.length) return 'totp';
        await this.audit(userId, 'system', 'replay_rejected');
        throw new UnauthorizedException('That code was already used. Wait for the next one.');
      }
      return this.registerFailure(userId, s, 'bad totp');
    }

    if (allowRecovery) {
      const norm = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const rows = await this.q<any>(`SELECT id, code_hash FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL`, [userId]);
      for (const r of rows) {
        if (await bcrypt.compare(norm, r.code_hash)) {
          const used = await this.q(`UPDATE user_recovery_codes SET used_at = now() WHERE id=$1 AND used_at IS NULL RETURNING id`, [r.id]);
          if (!used.length) break; // lost a race with another request using the same code
          await this.users.query(`UPDATE usermaster SET totp_failed_count = 0 WHERE userid=$1`, [userId]);
          await this.audit(userId, 'system', 'recovery_used');
          return 'recovery';
        }
      }
      return this.registerFailure(userId, s, 'bad recovery');
    }
    return this.registerFailure(userId, s, 'bad code format');
  }

  // ------------------------------------------------------------ enrolment

  private async checkPassword(userId: number, password: string): Promise<void> {
    const um = await this.users.findOne({ where: { userid: userId } });
    if (!um || !(await um.validatePassword(password || ''))) {
      throw new UnauthorizedException('Password is incorrect');
    }
  }

  /** `password` is required for a signed-in user; skipped when the password was just proven at login. */
  async beginEnroll(userId: number, opts: { password?: string; skipPassword?: boolean }) {
    if (!opts.skipPassword) await this.checkPassword(userId, opts.password || '');
    const s = await this.getSettings();
    if (s.policy === 'off') throw new BadRequestException('Two-factor authentication is switched off by the administrator');
    const u = await this.row(userId);
    if (!u) throw new UnauthorizedException('User not found');
    if (u.totp_enabled) throw new BadRequestException('Two-factor authentication is already on. Disable it first to set up a new device.');
    const secret = generateSecret();
    await this.users.query(`UPDATE usermaster SET totp_secret_enc=$2, totp_enabled=false WHERE userid=$1`, [userId, this.encrypt(secret)]);
    const url = otpauthUrl(secret, u.susername, s.issuer);
    return { secret, otpauthUrl: url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 240 }) };
  }

  private async makeRecoveryCodes(userId: number): Promise<string[]> {
    const s = await this.getSettings();
    const codes: string[] = [];
    for (let i = 0; i < s.recoveryCount; i++) {
      let c = '';
      for (const b of crypto.randomBytes(8)) c += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
      codes.push(`${c.slice(0, 4)}-${c.slice(4)}`);
    }
    await this.users.query(`DELETE FROM user_recovery_codes WHERE user_id=$1`, [userId]);
    for (const c of codes) {
      await this.users.query(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1,$2)`, [userId, await bcrypt.hash(c.replace('-', ''), 10)]);
    }
    return codes;
  }

  async confirmEnroll(userId: number, code: string): Promise<{ recoveryCodes: string[] }> {
    const u = await this.row(userId);
    if (!u?.totp_secret_enc || u.totp_enabled) throw new BadRequestException('Start set-up first');
    const step = verifyTotp(this.decrypt(u.totp_secret_enc), code);
    if (step === null) {
      await this.audit(userId, 'system', 'enrol_bad_code');
      throw new UnauthorizedException('That code is not right. Check the time on your phone and try again.');
    }
    await this.users.query(
      `UPDATE usermaster SET totp_enabled=true, totp_enrolled_at=now(), totp_last_step=$2, totp_failed_count=0, totp_locked_until=NULL WHERE userid=$1`,
      [userId, step],
    );
    const recoveryCodes = await this.makeRecoveryCodes(userId);
    await this.audit(userId, u.susername, 'enrolled');
    return { recoveryCodes };
  }

  async disable(userId: number, password: string, code: string): Promise<void> {
    await this.checkPassword(userId, password);
    const g = await this.gate(userId);
    if (g.required) throw new ForbiddenException('Your administrator requires two-factor authentication for your account');
    await this.verifyUserCode(userId, code, true);
    await this.wipe(userId);
    await this.audit(userId, 'self', 'disabled');
  }

  async regenerateRecovery(userId: number, code: string): Promise<string[]> {
    await this.verifyUserCode(userId, code, false);
    const codes = await this.makeRecoveryCodes(userId);
    await this.audit(userId, 'self', 'recovery_regenerated');
    return codes;
  }

  private async wipe(userId: number): Promise<void> {
    await this.users.query(
      `UPDATE usermaster SET totp_secret_enc=NULL, totp_enabled=false, totp_last_step=NULL, totp_enrolled_at=NULL,
              totp_failed_count=0, totp_locked_until=NULL WHERE userid=$1`,
      [userId],
    );
    await this.users.query(`DELETE FROM user_recovery_codes WHERE user_id=$1`, [userId]);
    await this.users.query(`DELETE FROM trusted_devices WHERE user_id=$1`, [userId]);
  }

  async adminReset(targetUserId: number, actor: string): Promise<void> {
    const u = await this.row(targetUserId);
    if (!u) throw new BadRequestException('User not found');
    await this.wipe(targetUserId);
    await this.audit(targetUserId, actor, 'admin_reset', `by ${actor}`);
  }

  async adminList() {
    const s = await this.getSettings();
    const rows = await this.q<any>(
      `SELECT u.userid, u.susername, u.userlevelid, l.userlevel AS level, u.enable_disable, u.totp_enabled, u.totp_enrolled_at,
              (u.totp_locked_until IS NOT NULL AND u.totp_locked_until > now()) AS locked
         FROM usermaster u LEFT JOIN userlevelmaster l ON l.userlevelid = u.userlevelid
        ORDER BY u.susername`,
    );
    return rows.map((r) => ({
      userid: r.userid,
      username: r.susername,
      level: r.level,
      levelId: r.userlevelid,
      enabled: r.enable_disable === 'E',
      enrolled: !!r.totp_enabled,
      enrolledAt: r.totp_enrolled_at,
      locked: !!r.locked,
      required: s.policy === 'all' || (s.policy === 'roles' && s.requiredLevelIds.includes(Number(r.userlevelid))),
    }));
  }

  async levels() {
    return this.q<any>(`SELECT userlevelid AS id, userlevel AS name FROM userlevelmaster ORDER BY userlevelid`);
  }

  async clearLock(userId: number, actor: string) {
    await this.users.query(`UPDATE usermaster SET totp_failed_count=0, totp_locked_until=NULL WHERE userid=$1`, [userId]);
    await this.audit(userId, actor, 'lock_cleared');
  }

  // ------------------------------------------------- action guard (ES-116 / ES-124)
  //
  // Workflow: an administrator grants the "Approver (OTP)" right to existing users (Access
  // Privilege Matrix, or the Approvers list in the 2FA settings). Each approver keeps their OWN
  // authenticator (set up in My Profile). To perform a protected action, whoever is doing the work
  // asks an approver for the current code and types it in; the system finds which approver's
  // authenticator it belongs to, so the audit log names the approver. A code works once.

  /** Users who currently count as approvers: enabled, hold the right, and have an authenticator. */
  private async activeApprovers(): Promise<Array<{ id: number; username: string; secretEnc: string }>> {
    const rows = await this.q<any>(
      `SELECT userid, susername, totp_secret_enc FROM usermaster
        WHERE enable_disable = 'E' AND totp_enabled = true AND totp_secret_enc IS NOT NULL
          AND (',' || COALESCE("permissions", '') || ',') LIKE '%,approve_actions,%'`,
    );
    return rows.map((r) => ({ id: Number(r.userid), username: r.susername, secretEnc: r.totp_secret_enc }));
  }

  async getGuards(): Promise<Record<string, GuardConfig>> {
    const rows = await this.q<{ key: string; value: string }>(`SELECT "key", "value" FROM system_settings WHERE "key" LIKE 'twofa.guard.%'`);
    const out: Record<string, GuardConfig> = {};
    for (const a of Object.keys(GUARD_ACTIONS)) {
      const raw = rows.find((r) => r.key === 'twofa.guard.' + a)?.value;
      let c: Partial<GuardConfig> = {};
      try { c = raw ? JSON.parse(raw) : {}; } catch { /* corrupt value = defaults */ }
      // Default OFF: switching it on before any approver exists would block the action for everyone.
      out[a] = { enabled: !!c.enabled };
    }
    return out;
  }

  /** Every user with whether they are an approver and whether their authenticator is set up. */
  async listApprovers() {
    const rows = await this.q<any>(
      `SELECT u.userid, u.susername, u.enable_disable, u.totp_enabled, l.userlevel AS level,
              ((',' || COALESCE(u."permissions", '') || ',') LIKE '%,approve_actions,%') AS approver
         FROM usermaster u LEFT JOIN userlevelmaster l ON l.userlevelid = u.userlevelid
        ORDER BY u.susername`,
    );
    return rows.map((r) => ({
      userid: Number(r.userid),
      username: r.susername,
      level: r.level,
      enabled: r.enable_disable === 'E',
      enrolled: !!r.totp_enabled,
      approver: !!r.approver,
      /** counts today: has the right AND an authenticator AND the account is enabled */
      active: !!r.approver && !!r.totp_enabled && r.enable_disable === 'E',
    }));
  }

  /** Grant or remove the Approver right (admin only). Effective immediately. */
  async setApprovers(add: number[], remove: number[], actor: { id: number; username: string }) {
    const clean = (a: any) => [...new Set((a || []).map((n: any) => Math.trunc(Number(n))).filter((n: number) => Number.isFinite(n)))] as number[];
    for (const [ids, grant] of [[clean(add), true], [clean(remove), false]] as Array<[number[], boolean]>) {
      for (const id of ids) {
        const um = await this.users.findOne({ where: { userid: id }, relations: ['userLevel'] });
        if (!um) throw new BadRequestException('User ' + id + ' not found');
        if (grant && um.enableDisable !== 'E') throw new BadRequestException(um.susername + ' is disabled and cannot be an approver');
        // Rows that never had explicit rights fall back to role defaults; materialise those first so
        // granting this one right does not wipe the user's other rights.
        const current: string[] = um.hasExplicitPermissions ? um.permissions : (mapUserMasterToUser(um).permissions as string[]);
        const next = grant ? [...new Set([...current, 'approve_actions'])] : current.filter((p) => p !== 'approve_actions');
        // Raw UPDATE on purpose: repository.save() would run the password-hashing hook on legacy passwords.
        await this.users.query(`UPDATE usermaster SET "permissions" = $1, updated_at = now() WHERE userid = $2`, [next.join(','), id]);
        await this.audit(id, actor.username, grant ? 'approver_added' : 'approver_removed', um.susername);
      }
    }
    return this.listApprovers();
  }

  /**
   * Matches a typed code against the approvers' own authenticators.
   * `ok` consumes that approver's 30-second step (one use). `self` = the only match is the performer
   * and approving one's own action is not allowed. Recovery codes (admin operations only) are the
   * approvers' personal recovery codes.
   */
  private async checkApproverCode(
    code: string,
    performerId: number,
    allowRecovery: boolean,
  ): Promise<{ result: 'ok' | 'replay' | 'bad' | 'self'; approver?: { id: number; username: string } }> {
    const s = await this.getSettings();
    const approvers = await this.activeApprovers();
    const input = String(code || '').trim();

    if (/^\d{6}$/.test(input.replace(/\s+/g, ''))) {
      const matches: Array<{ a: (typeof approvers)[number]; step: number }> = [];
      for (const a of approvers) {
        const step = verifyTotp(this.decrypt(a.secretEnc), input);
        if (step !== null) matches.push({ a, step });
      }
      if (!matches.length) return { result: 'bad' };
      const eligible = matches.filter((m) => s.approverCanApproveOwn || m.a.id !== performerId);
      if (!eligible.length) return { result: 'self' };
      const m = eligible[0];
      // Conditional update = atomic one-use guard across concurrent requests.
      const claimed = await this.q(
        `UPDATE usermaster SET totp_last_step = $2, totp_failed_count = 0
          WHERE userid = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING userid`,
        [m.a.id, m.step],
      );
      return claimed.length ? { result: 'ok', approver: { id: m.a.id, username: m.a.username } } : { result: 'replay' };
    }

    if (allowRecovery) {
      const norm = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (norm.length >= 8) {
        for (const a of approvers) {
          if (!s.approverCanApproveOwn && a.id === performerId) continue;
          const rows = await this.q<any>(`SELECT id, code_hash FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [a.id]);
          for (const r of rows) {
            if (await bcrypt.compare(norm, r.code_hash)) {
              const used = await this.q(`UPDATE user_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`, [r.id]);
              if (used.length) return { result: 'ok', approver: { id: a.id, username: a.username } };
            }
          }
        }
      }
    }
    return { result: 'bad' };
  }

  /** Wrong password is a 403 (not 401) so the app does not mistake it for an expired session. */
  private async checkPasswordForbidden(userId: number, password: string): Promise<void> {
    const um = await this.users.findOne({ where: { userid: userId } });
    // Same rule as signing in (including the configured super-admin fallback), so "your login password" means the same thing here.
    if (!um || !(await um.validatePassword(password || '', this.config.get<string>('SUPER_ADMIN_PASSWORD')))) {
      throw new ForbiddenException({ statusCode: 403, code: 'GUARD_CONFIRM_INVALID', message: 'Your password is not correct' });
    }
  }

  /**
   * Administrator operations on the guards: the logged-in admin's password AND an approver's code
   * (live code, or one of the approver's recovery codes). Safety valve: if there is no approver other
   * than the admin who could give a code, the password alone is enough (otherwise nobody could ever
   * switch a protection off again).
   */
  private async confirmAdminAction(adminId: number, password: string, code: string): Promise<void> {
    const s = await this.getSettings();
    const u = await this.row(adminId);
    if (u?.totp_locked_until && new Date(u.totp_locked_until).getTime() > Date.now()) {
      throw new ForbiddenException({ statusCode: 403, code: 'GUARD_CONFIRM_INVALID', message: 'Too many wrong attempts. Try again later.' });
    }
    await this.checkPasswordForbidden(adminId, password);
    const others = (await this.activeApprovers()).filter((a) => s.approverCanApproveOwn || a.id !== adminId);
    if (others.length === 0) return;
    const r = await this.checkApproverCode(code, adminId, true);
    if (r.result === 'ok') {
      await this.audit(adminId, 'admin', 'admin_op_approved', 'approved by ' + r.approver!.username);
      return;
    }
    const bad = (message: string) => new ForbiddenException({ statusCode: 403, code: 'GUARD_CONFIRM_INVALID', message });
    if (r.result === 'replay') throw bad('That approval code was already used. Ask the approver for the next one.');
    if (r.result === 'self') throw bad('You cannot approve your own change. Ask another approver for the code.');
    try { await this.registerFailure(adminId, s, 'bad approver code (admin op)'); }
    catch (e: any) { throw bad(e?.message || 'Approval code is not correct'); }
  }

  async saveGuards(
    patch: Record<string, Partial<GuardConfig>>,
    actor: { id: number; username: string },
    confirm?: { password?: string; code?: string },
  ): Promise<Record<string, GuardConfig>> {
    const cur = await this.getGuards();
    const turningOff: string[] = [];
    const turningOn: string[] = [];
    for (const [a, p] of Object.entries(patch || {})) {
      if (!GUARD_ACTIONS[a]) throw new BadRequestException('Unknown action ' + a);
      if (p.enabled === undefined) continue;
      if (cur[a].enabled && !p.enabled) turningOff.push(a);
      if (!cur[a].enabled && p.enabled) turningOn.push(a);
    }
    if (turningOn.length && (await this.activeApprovers()).length === 0) {
      throw new BadRequestException('No approver is set up yet. Give at least one user the Approver right and have them set up their authenticator (My Profile), then switch protections on.');
    }
    if (turningOff.length) {
      // Switching a protection off needs the logged-in admin's password AND an approver's code.
      if (!confirm?.password) {
        throw new ForbiddenException({
          statusCode: 403, code: 'GUARD_OFF_CONFIRM_REQUIRED',
          message: 'To switch a protection off, enter your password and a current approver code.',
        });
      }
      await this.confirmAdminAction(actor.id, confirm.password, confirm.code || '');
    }
    for (const [a, p] of Object.entries(patch || {})) {
      if (p.enabled === undefined) continue;
      await this.setKey('guard.' + a, JSON.stringify({ enabled: !!p.enabled }));
      if (cur[a].enabled !== !!p.enabled) {
        await this.audit(actor.id, actor.username, p.enabled ? 'guard_on' : 'guard_off', GUARD_ACTIONS[a].label);
      }
    }
    return this.getGuards();
  }

  /** Is this voucher a loan re-agreement? (used to pick the right guard on Pass Transactions) */
  async isReagreementVoucher(voucherNo: string): Promise<boolean> {
    const r = await this.q<any>(`SELECT "sourceModule", remarks FROM vouchers WHERE "voucherNumber" = $1`, [voucherNo]);
    return !!r[0] && (r[0].sourceModule === 'LOAN_REAGREEMENT' || /REAGREEMENT:\d+/.test(r[0].remarks || ''));
  }

  /**
   * Called before a protected action runs. Does nothing when no listed action is switched on, so a
   * window with its switch OFF behaves exactly as before. Otherwise the typed code must be a current
   * code from an approver's authenticator (by default not the performer's own); one code covers every
   * action in the list. The approver's name goes into the audit log.
   */
  async enforceActions(actions: string[], user: { id: number; username: string }, code: string | undefined, target: string): Promise<void> {
    const guards = await this.getGuards();
    const active = actions.filter((a) => guards[a]?.enabled);
    if (active.length === 0) return;
    const first = active[0];
    const fail = (codeName: string, message: string): never => {
      throw new ForbiddenException({ statusCode: 403, code: codeName, authAction: first, authLabel: GUARD_ACTIONS[first].label, message });
    };

    if ((await this.activeApprovers()).length === 0) {
      fail('AUTH_CODE_NOT_CONFIGURED', GUARD_ACTIONS[first].label + ' needs an approver code, but no approver is set up. Ask the administrator (Administration > Security > Two-Factor Authentication).');
    }
    if (!code || !String(code).trim()) {
      fail('AUTH_CODE_REQUIRED', 'Ask an approver for their current code and enter it');
    }
    const s = await this.getSettings();
    const u = await this.row(user.id);
    if (u?.totp_locked_until && new Date(u.totp_locked_until).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(u.totp_locked_until).getTime() - Date.now()) / 60000);
      throw new ForbiddenException(`Too many wrong codes. Try again in ${mins} minute(s).`);
    }
    const r = await this.checkApproverCode(String(code), user.id, false);
    if (r.result === 'replay') fail('AUTH_CODE_INVALID', 'That code was already used. Ask the approver for the next code.');
    if (r.result === 'self') fail('AUTH_CODE_INVALID', 'You cannot approve your own action. Ask another approver for their code.');
    if (r.result !== 'ok') {
      // Count the wrong code against the PERFORMER (brute-force brake), then ask again.
      try { await this.registerFailure(user.id, s, 'bad approver code'); }
      catch (e: any) {
        if (e?.getStatus?.() === 403) throw e; // locked out
        fail('AUTH_CODE_INVALID', 'That approver code is not correct');
      }
    }
    await this.users.query(`UPDATE usermaster SET totp_failed_count = 0 WHERE userid = $1`, [user.id]);
    for (const a of active) await this.audit(user.id, user.username, 'action_approved', `${a} ${target} approved by ${r.approver!.username}`);
  }

  // -------------------------------------------------------- trusted device

  private hash(t: string) {
    return crypto.createHash('sha256').update(t).digest('hex');
  }

  private async isTrusted(userId: number, token: string): Promise<boolean> {
    const r = await this.q(`SELECT 1 FROM trusted_devices WHERE user_id=$1 AND token_hash=$2 AND expires_at > now()`, [userId, this.hash(token)]);
    return r.length > 0;
  }

  async trustDevice(userId: number): Promise<string | null> {
    const s = await this.getSettings();
    if (s.rememberDays <= 0) return null;
    const token = crypto.randomBytes(32).toString('hex');
    await this.users.query(`DELETE FROM trusted_devices WHERE expires_at < now()`);
    await this.users.query(
      `INSERT INTO trusted_devices (user_id, token_hash, expires_at) VALUES ($1,$2, now() + ($3 || ' days')::interval)`,
      [userId, this.hash(token), String(s.rememberDays)],
    );
    return token;
  }
}
