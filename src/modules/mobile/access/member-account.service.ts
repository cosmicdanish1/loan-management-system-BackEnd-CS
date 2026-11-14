import { BadRequestException, HttpException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { MobileAuditService } from '../audit/mobile-audit.service';
import { MOBILE_DS } from '../mobile.constants';
import { ClientCtx } from './access.types';
import { AppCodeService } from './app-code.service';
import { MemberDirectoryService } from './member-directory.service';
import { MAX_MPIN_TRIES } from './member-auth.service';
import { sha256, weakMpinReason } from './mobile-crypto';
import { SessionService } from './session.service';

interface Who {
  mbno: string;
  deviceId: number; // the database id of the phone the call came from
}

/** What the app shows for the member's own activation request (no staff names, no internals). */
export type ActivationRequestState = 'NONE' | 'WAITING' | 'CALLED_BACK' | 'APPROVED' | 'REJECTED';

/**
 * Member-side account routes after sign-in (ES-392): change MPIN, list/remove phones, deactivate, and the status of an
 * activation request. Sensitive ones need an App Code approval for exactly that action (PRD 9.5).
 */
@Injectable()
export class MemberAccountService {
  constructor(
    @InjectDataSource(MOBILE_DS) private readonly ds: DataSource,
    private readonly sessions: SessionService,
    private readonly appCode: AppCodeService,
    private readonly directory: MemberDirectoryService,
    private readonly audit: MobileAuditService,
  ) {}

  /** Old MPIN + new MPIN + App Code approval. A wrong old MPIN counts like a wrong MPIN at sign-in (5 = locked). */
  async changeMpin(member: Who, input: { oldMpin: string; newMpin: string }, approval: string | undefined, ctx: ClientCtx): Promise<{ changed: true }> {
    await this.appCode.requireApproval(member, 'CHANGE_MPIN', approval);

    const rows: any[] = await this.ds.query(`SELECT status, mpin_hash, failed_attempts FROM mobile_account WHERE mbno = $1`, [member.mbno]);
    const a = rows[0];
    if (!a || a.status !== 'ACTIVE' || !a.mpin_hash) {
      throw new UnauthorizedException({ statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'Please sign in again' });
    }

    const ok = await bcrypt.compare(input.oldMpin, a.mpin_hash);
    if (!ok) {
      const attempts = Number(a.failed_attempts) + 1;
      const lock = attempts >= MAX_MPIN_TRIES;
      await this.ds.query(
        `UPDATE mobile_account SET failed_attempts = $2, status = CASE WHEN $3 THEN 'LOCKED' ELSE status END, updated_at = now() WHERE mbno = $1`,
        [member.mbno, attempts, lock],
      );
      await this.audit.log({ event: lock ? 'MPIN_LOCKED' : 'MPIN_CHANGE', result: 'FAIL', mbno: member.mbno, ...ctx, detail: { reason: 'wrong_old_mpin', attempts } });
      if (lock) {
        await this.sessions.revokeAllForMember(member.mbno);
        throw new HttpException({ statusCode: 423, code: 'MPIN_LOCKED', message: 'Too many wrong MPIN attempts. Please contact the society to unlock.' }, 423);
      }
      throw new UnauthorizedException({ statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'Your current MPIN is not correct', attemptsLeft: MAX_MPIN_TRIES - attempts });
    }

    if (input.newMpin === input.oldMpin) {
      throw new BadRequestException({ statusCode: 400, code: 'MPIN_SAME_AS_OLD', message: 'The new MPIN must be different from the current one' });
    }
    const m = await this.directory.getMember(member.mbno);
    const weak = weakMpinReason(input.newMpin, m?.dob ?? null);
    if (weak) throw new BadRequestException({ statusCode: 400, code: 'MPIN_TOO_WEAK', message: weak });

    await this.ds.query(
      `UPDATE mobile_account SET mpin_hash = $2, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE mbno = $1`,
      [member.mbno, await bcrypt.hash(input.newMpin, 10)],
    );
    await this.audit.log({ event: 'MPIN_CHANGE', result: 'OK', mbno: member.mbno, ...ctx });
    return { changed: true };
  }

  /** The member's own trusted phones (revoked ones are not listed). */
  async listDevices(member: Who): Promise<Array<{ id: number; platform: string | null; model: string | null; osVersion: string | null; appVersion: string | null; lastSeen: string | null; addedAt: string; isCurrent: boolean }>> {
    const rows: any[] = await this.ds.query(
      `SELECT id, platform, model, os_version, app_version, last_seen, created_at
         FROM mobile_device WHERE mbno = $1 AND NOT revoked ORDER BY created_at DESC`,
      [member.mbno],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      platform: r.platform ?? null,
      model: r.model ?? null,
      osVersion: r.os_version ?? null,
      appVersion: r.app_version ?? null,
      lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
      addedAt: new Date(r.created_at).toISOString(),
      isCurrent: Number(r.id) === member.deviceId,
    }));
  }

  /** Signs another phone out for good. The phone being used cannot be removed here (that is sign-out or deactivate). */
  async removeDevice(member: Who, deviceId: number, approval: string | undefined, ctx: ClientCtx): Promise<{ removed: true }> {
    await this.appCode.requireApproval(member, 'ADD_REMOVE_DEVICE', approval);
    if (deviceId === member.deviceId) {
      throw new BadRequestException({ statusCode: 400, code: 'CANNOT_REMOVE_CURRENT_DEVICE', message: 'This is the phone you are using. Sign out instead.' });
    }
    const done: any[] = await this.ds.transaction(async (m) => {
      const upd: any[] = await m.query(
        `UPDATE mobile_device SET revoked = true, revoked_at = now(), revoked_by = 'member'
          WHERE id = $1 AND mbno = $2 AND NOT revoked RETURNING id`,
        [deviceId, member.mbno],
      );
      const hit = Array.isArray(upd[0]) ? upd[0] : upd;
      if (hit.length) {
        await this.sessions.revokeDevice(deviceId, m);
        await m.query(`DELETE FROM mobile_push_token WHERE device_id = $1`, [deviceId]);
      }
      return hit;
    });
    if (!done.length) throw new NotFoundException({ statusCode: 404, code: 'DEVICE_NOT_FOUND', message: 'That phone is not on your account' });
    await this.audit.log({ event: 'DEVICE_REMOVED', result: 'OK', mbno: member.mbno, ...ctx, detail: { removedDevice: deviceId } });
    return { removed: true };
  }

  /** Member switches mobile access off for good: every phone and session ends, the MPIN is deleted. Staff must issue a new code. */
  async deactivate(member: Who, approval: string | undefined, ctx: ClientCtx): Promise<{ deactivated: true }> {
    await this.appCode.requireApproval(member, 'DEACTIVATE_ACCESS', approval);
    await this.ds.transaction(async (m) => {
      // Only the member's own states: a blocked account stays blocked (staff decision), it is not silently turned into DEACTIVATED.
      await m.query(
        `UPDATE mobile_account SET status = 'DEACTIVATED', mpin_hash = NULL, failed_attempts = 0, locked_until = NULL, updated_at = now()
          WHERE mbno = $1 AND status IN ('ACTIVE', 'LOCKED')`,
        [member.mbno],
      );
      await m.query(`UPDATE mobile_device SET revoked = true, revoked_at = now(), revoked_by = 'member deactivated' WHERE mbno = $1 AND NOT revoked`, [member.mbno]);
      await this.sessions.revokeAllForMember(member.mbno, m);
      await m.query(`DELETE FROM mobile_push_token WHERE mbno = $1`, [member.mbno]);
    });
    await this.audit.log({ event: 'DEACTIVATED', result: 'OK', mbno: member.mbno, ...ctx });
    return { deactivated: true };
  }

  /**
   * "Waiting for the call-back" screen. Answers only for a request sent FROM THIS PHONE (matched by the device hash), so
   * nobody can probe another member's state with just a member number; anything else is the same answer: NONE.
   */
  async activationRequestStatus(mbno: string, ctx: ClientCtx): Promise<{ status: ActivationRequestState; requestedAt?: string }> {
    if (!ctx.deviceId || !/^\d{1,18}$/.test(mbno)) return { status: 'NONE' };
    const rows: any[] = await this.ds.query(
      `SELECT status, created_at FROM mobile_activation_request
        WHERE mbno = $1 AND device_id_hash = $2 AND created_at > now() - interval '7 days'
        ORDER BY created_at DESC LIMIT 1`,
      [mbno, sha256(ctx.deviceId)],
    );
    if (!rows.length) return { status: 'NONE' };
    const map: Record<string, ActivationRequestState> = { NEW: 'WAITING', CALLED_BACK: 'CALLED_BACK', APPROVED: 'APPROVED', REJECTED: 'REJECTED' };
    return { status: map[String(rows[0].status)] ?? 'WAITING', requestedAt: new Date(rows[0].created_at).toISOString() };
  }
}
