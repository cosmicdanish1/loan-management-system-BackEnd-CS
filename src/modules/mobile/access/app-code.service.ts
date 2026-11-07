import { ForbiddenException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { verifyTotp } from '../../auth/twofa/totp.util';
import { MobileAuditService } from '../audit/mobile-audit.service';
import { MOBILE_DS } from '../mobile.constants';
import { ClientCtx } from './access.types';
import { MobileCryptoService } from './mobile-crypto';

/** Sensitive actions that need the App Code (approved list, PRD 9.5). */
export const STEP_UP_ACTIONS = [
  'CHANGE_MPIN',
  'BIOMETRIC_TOGGLE',
  'ADD_REMOVE_DEVICE',
  'DEACTIVATE_ACCESS',
  'CHANGE_REQUEST',
  'LARGE_STATEMENT',
  'SECURITY_ALERT_SETTINGS',
] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

export type AppCodeResult = 'ok' | 'wrong' | 'locked' | 'replay' | 'no_secret';

const STEP_UP_TYPE = 'stepup';
export const APPCODE_MAX_WRONG = 5;
export const APPCODE_LOCK_MINUTES = 15;

/**
 * App Code (ES-385): the member's phone shows a 6-digit TOTP made from a secret handed over once at activation.
 * The server keeps the secret encrypted and checks the code (+/- 30 s). Used (a) before sensitive actions inside the app
 * and (b) by staff to verify a member at the counter or on a call.
 */
@Injectable()
export class AppCodeService {
  constructor(
    @InjectDataSource(MOBILE_DS) private readonly ds: DataSource,
    private readonly crypto: MobileCryptoService,
    private readonly jwt: JwtService,
    private readonly audit: MobileAuditService,
  ) {}

  /**
   * Checks a code for one phone. 5 wrong codes lock this check for 15 minutes; a code that was already accepted can never
   * be accepted again (replay protection, same method as the staff authenticator).
   */
  async check(deviceDbId: number, mbno: string, code: string, nowMs = Date.now()): Promise<AppCodeResult> {
    const rows: any[] = await this.ds.query(
      `SELECT appcode_secret_enc, appcode_wrong, appcode_last_step, appcode_locked_until
         FROM mobile_device WHERE id = $1 AND mbno = $2 AND NOT revoked`,
      [deviceDbId, mbno],
    );
    const d = rows[0];
    if (!d || !d.appcode_secret_enc) return 'no_secret';
    if (d.appcode_locked_until && new Date(d.appcode_locked_until).getTime() > nowMs) return 'locked';

    const step = verifyTotp(this.crypto.decrypt(d.appcode_secret_enc), code, 1, nowMs);
    if (step === null) {
      const wrong = Number(d.appcode_wrong) + 1;
      const lock = wrong >= APPCODE_MAX_WRONG;
      await this.ds.query(
        `UPDATE mobile_device SET appcode_wrong = $2, appcode_locked_until = $3 WHERE id = $1`,
        [deviceDbId, lock ? 0 : wrong, lock ? new Date(nowMs + APPCODE_LOCK_MINUTES * 60000) : null],
      );
      return lock ? 'locked' : 'wrong';
    }
    if (d.appcode_last_step !== null && Number(d.appcode_last_step) >= step) return 'replay';
    await this.ds.query(`UPDATE mobile_device SET appcode_wrong = 0, appcode_locked_until = NULL, appcode_last_step = $2 WHERE id = $1`, [deviceDbId, step]);
    return 'ok';
  }

  /** Member route: POST /auth/step-up. Returns a 2-minute approval that covers exactly one action. */
  async stepUp(member: { mbno: string; deviceId: number }, action: string, code: string, ctx: ClientCtx): Promise<{ approval: string; expiresIn: number }> {
    if (!(STEP_UP_ACTIONS as readonly string[]).includes(action)) {
      throw new HttpException({ statusCode: 400, code: 'UNKNOWN_ACTION', message: 'This action does not use the App Code' }, 400);
    }
    const r = await this.check(member.deviceId, member.mbno, code);
    if (r !== 'ok') {
      await this.audit.log({ event: 'STEP_UP', result: 'FAIL', mbno: member.mbno, ...ctx, detail: { action, reason: r } });
      if (r === 'locked') {
        throw new ForbiddenException({ statusCode: 403, code: 'APPCODE_LOCKED', message: `Too many wrong codes. Try again in ${APPCODE_LOCK_MINUTES} minutes.` });
      }
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'APPCODE_INVALID',
        message: r === 'replay' ? 'That code was already used. Wait for the next code.' : 'The App Code is not correct',
      });
    }
    const approval = await this.jwt.signAsync({ typ: STEP_UP_TYPE, mbno: member.mbno, did: member.deviceId, act: action }, { expiresIn: '2m' });
    await this.audit.log({ event: 'STEP_UP', result: 'OK', mbno: member.mbno, ...ctx, detail: { action } });
    return { approval, expiresIn: 120 };
  }

  /** Routes that perform a sensitive action call this: the approval must be for THIS member, THIS phone and THIS action. */
  async requireApproval(member: { mbno: string; deviceId: number }, action: StepUpAction, approval: string | undefined): Promise<void> {
    const deny = () => new ForbiddenException({ statusCode: 403, code: 'APPCODE_REQUIRED', message: 'Enter your App Code to continue', action });
    if (!approval) throw deny();
    let claims: any;
    try {
      claims = await this.jwt.verifyAsync(approval);
    } catch {
      throw deny();
    }
    if (claims?.typ !== STEP_UP_TYPE || claims.mbno !== member.mbno || Number(claims.did) !== member.deviceId || claims.act !== action) throw deny();
  }

  /** Staff route: the member reads the code from his phone; staff type it in the Control Center. */
  async verifyForStaff(mbno: string, code: string, staffName: string): Promise<{ result: AppCodeResult | 'no_device' }> {
    const dev: any[] = await this.ds.query(
      `SELECT id FROM mobile_device WHERE mbno = $1 AND NOT revoked AND appcode_secret_enc IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [mbno],
    );
    if (!dev.length) return { result: 'no_device' };
    const result = await this.check(Number(dev[0].id), mbno, code);
    await this.audit.log({ event: 'APPCODE_STAFF_VERIFY', result: result === 'ok' ? 'OK' : 'FAIL', mbno, detail: { by: staffName, outcome: result } });
    return { result };
  }
}
