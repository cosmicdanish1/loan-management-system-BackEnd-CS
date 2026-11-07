import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivationService } from '../access/activation.service';
import { AppCodeService } from '../access/app-code.service';
import { MemberDirectoryService, SHARED_PHONE_LIMIT } from '../access/member-directory.service';
import { SessionService } from '../access/session.service';
import { MobileAuditService } from '../audit/mobile-audit.service';
import { MOBILE_DS } from '../mobile.constants';

export interface MemberAccessRow {
  mbno: string;
  name: string;
  accessStatus: string;
  phoneStatus: string;
  lastLogin: string | null;
}

/** Staff-side logic of the Mobile Control Center (member access, activation requests). ES-230 / ES-237. */
@Injectable()
export class MobileAdminService {
  constructor(
    @InjectDataSource(MOBILE_DS) private readonly ds: DataSource,
    private readonly directory: MemberDirectoryService,
    private readonly activation: ActivationService,
    private readonly appCode: AppCodeService,
    private readonly sessions: SessionService,
    private readonly audit: MobileAuditService,
  ) {}

  private async requireMember(mbno: string) {
    const m = await this.directory.getMember(mbno);
    if (!m) throw new NotFoundException('Member not found');
    return m;
  }

  /** Search by member number (exact or starting with) or by name. */
  async searchMembers(q: string): Promise<MemberAccessRow[]> {
    const term = (q || '').trim();
    if (term.length < 2) return [];
    const numeric = /^\d+$/.test(term);
    const rows: any[] = await this.ds.query(
      `SELECT m.mbno::text AS mbno,
              COALESCE(NULLIF(trim(m.full_name), ''), trim(concat_ws(' ', m.f_name, m.m_name, m.l_name))) AS name,
              COALESCE(a.status, 'NOT_ACTIVATED') AS access_status,
              (SELECT max(last_seen) FROM mobile_device d WHERE d.mbno = m.mbno) AS last_login
         FROM member_master m
         LEFT JOIN mobile_account a ON a.mbno = m.mbno
        WHERE ${numeric ? `m.mbno::text LIKE $1 || '%'` : `(m.full_name ILIKE '%' || $1 || '%' OR concat_ws(' ', m.f_name, m.m_name, m.l_name) ILIKE '%' || $1 || '%')`}
        ORDER BY m.mbno LIMIT 25`,
      [term],
    );
    const out: MemberAccessRow[] = [];
    for (const r of rows) {
      const member = await this.directory.getMember(r.mbno);
      const pq = await this.directory.phoneQuality(member?.phone10 ?? null);
      out.push({ mbno: r.mbno, name: r.name || '', accessStatus: r.access_status, phoneStatus: pq.status, lastLogin: r.last_login ? new Date(r.last_login).toISOString() : null });
    }
    return out;
  }

  async memberDetail(mbno: string) {
    const m = await this.requireMember(mbno);
    const pq = await this.directory.phoneQuality(m.phone10);
    const [account, devices, codes, requests, events]: any[][] = await Promise.all([
      this.ds.query(`SELECT status, failed_attempts, locked_until, activated_at, blocked_reason, blocked_by, updated_at FROM mobile_account WHERE mbno = $1`, [m.mbno]),
      this.ds.query(`SELECT id, platform, model, app_version, last_seen, revoked, created_at FROM mobile_device WHERE mbno = $1 ORDER BY created_at DESC`, [m.mbno]),
      this.ds.query(`SELECT issued_by, issued_at, expires_at, used_at, burned, wrong_attempts FROM mobile_activation_code WHERE mbno = $1 ORDER BY issued_at DESC LIMIT 5`, [m.mbno]),
      this.ds.query(`SELECT id, status, match_result, created_at, handled_by, handled_at, note FROM mobile_activation_request WHERE mbno = $1 ORDER BY created_at DESC LIMIT 5`, [m.mbno]),
      this.ds.query(`SELECT at, event, result, detail FROM mobile_audit_log WHERE mbno = $1 ORDER BY at DESC LIMIT 15`, [m.mbno]),
    ]);
    return {
      member: {
        mbno: m.mbno,
        name: m.fullName,
        isActive: m.isActive,
        phone: m.phone10, // staff screen only: needed for the call-back
        phoneStatus: pq.status,
        phoneSharedCount: pq.sharedCount,
      },
      access: account[0]
        ? {
            status: account[0].status,
            failedAttempts: account[0].failed_attempts,
            lockedUntil: account[0].locked_until,
            activatedAt: account[0].activated_at,
            blockedReason: account[0].blocked_reason,
            blockedBy: account[0].blocked_by,
          }
        : { status: 'NOT_ACTIVATED', failedAttempts: 0 },
      devices: devices.map((d) => ({ id: Number(d.id), platform: d.platform, model: d.model, appVersion: d.app_version, lastSeen: d.last_seen, revoked: d.revoked, since: d.created_at })),
      codes: codes.map((c) => ({ issuedBy: c.issued_by, issuedAt: c.issued_at, expiresAt: c.expires_at, usedAt: c.used_at, burned: c.burned, wrongAttempts: c.wrong_attempts })),
      requests: requests.map((r) => ({ id: Number(r.id), status: r.status, match: r.match_result, createdAt: r.created_at, handledBy: r.handled_by, handledAt: r.handled_at, note: r.note })),
      recentActivity: events.map((e) => ({ at: e.at, event: e.event, result: e.result, detail: e.detail })),
    };
  }

  async issueCode(mbno: string, staff: string) {
    return this.activation.issueCode(mbno, staff);
  }

  /** Staff-assisted MPIN reset: sign the member out everywhere and give a new code (setting a new MPIN re-activates). */
  async resetMpin(mbno: string, staff: string) {
    const m = await this.requireMember(mbno);
    await this.sessions.revokeAllForMember(m.mbno);
    const issued = await this.activation.issueCode(m.mbno, staff);
    await this.audit.log({ event: 'STAFF_RESET_MPIN', result: 'OK', mbno: m.mbno, detail: { by: staff } });
    return issued;
  }

  async unlock(mbno: string, staff: string): Promise<{ status: string }> {
    const m = await this.requireMember(mbno);
    const r: any[] = await this.ds.query(
      `UPDATE mobile_account SET status = 'ACTIVE', failed_attempts = 0, locked_until = NULL, updated_at = now()
        WHERE mbno = $1 AND status = 'LOCKED' RETURNING mbno`,
      [m.mbno],
    );
    if (!(Array.isArray(r[0]) ? r[0] : r).length) throw new BadRequestException('This member is not locked');
    await this.audit.log({ event: 'STAFF_UNLOCK', result: 'OK', mbno: m.mbno, detail: { by: staff } });
    return { status: 'ACTIVE' };
  }

  async block(mbno: string, reason: string, staff: string): Promise<{ status: string }> {
    const m = await this.requireMember(mbno);
    await this.ds.query(
      `INSERT INTO mobile_account (mbno, status, blocked_reason, blocked_by) VALUES ($1, 'BLOCKED', $2, $3)
       ON CONFLICT (mbno) DO UPDATE SET status = 'BLOCKED', blocked_reason = $2, blocked_by = $3, updated_at = now()`,
      [m.mbno, reason.slice(0, 300), staff.slice(0, 100)],
    );
    await this.sessions.revokeAllForMember(m.mbno);
    await this.audit.log({ event: 'STAFF_BLOCK', result: 'OK', mbno: m.mbno, detail: { by: staff, reason: reason.slice(0, 300) } });
    return { status: 'BLOCKED' };
  }

  async unblock(mbno: string, staff: string): Promise<{ status: string }> {
    const m = await this.requireMember(mbno);
    const r: any[] = await this.ds.query(
      `UPDATE mobile_account
          SET status = CASE WHEN mpin_hash IS NOT NULL THEN 'ACTIVE' ELSE 'NOT_ACTIVATED' END,
              blocked_reason = NULL, blocked_by = NULL, updated_at = now()
        WHERE mbno = $1 AND status = 'BLOCKED' RETURNING status`,
      [m.mbno],
    );
    const rows = Array.isArray(r[0]) ? r[0] : r;
    if (!rows.length) throw new BadRequestException('This member is not blocked');
    await this.audit.log({ event: 'STAFF_UNBLOCK', result: 'OK', mbno: m.mbno, detail: { by: staff } });
    return { status: rows[0].status };
  }

  /** Lost phone: every phone and session of the member stops working; a new activation code is needed. */
  async signOutEverywhere(mbno: string, staff: string): Promise<{ devicesRevoked: number }> {
    const m = await this.requireMember(mbno);
    const r: any[] = await this.ds.query(
      `UPDATE mobile_device SET revoked = true, revoked_at = now(), revoked_by = $2 WHERE mbno = $1 AND NOT revoked RETURNING id`,
      [m.mbno, `staff: ${staff}`.slice(0, 100)],
    );
    const rows = Array.isArray(r[0]) ? r[0] : r;
    await this.sessions.revokeAllForMember(m.mbno);
    await this.audit.log({ event: 'STAFF_SIGN_OUT_ALL', result: 'OK', mbno: m.mbno, detail: { by: staff, devices: rows.length } });
    return { devicesRevoked: rows.length };
  }

  verifyAppCode(mbno: string, code: string, staff: string) {
    return this.appCode.verifyForStaff(mbno, code, staff);
  }

  // ───────────── phone data quality (ES-232) ─────────────

  /** Every active member is exactly one of OK / MISSING / INVALID / SHARED (a number used by more than 3 members). */
  private static readonly PHONE_CTE = String.raw`
    WITH m AS (
      SELECT mbno, right(regexp_replace(COALESCE(phoneno, ''), '[^0-9]', '', 'g'), 10) AS p, COALESCE(isactive, 'Y') AS act,
             COALESCE(NULLIF(trim(full_name), ''), trim(concat_ws(' ', f_name, m_name, l_name))) AS name
        FROM member_master
    ),
    cnt AS (SELECT p, count(*) AS n FROM m WHERE length(p) = 10 GROUP BY p),
    q AS (
      SELECT m.mbno, m.name, m.p, COALESCE(cnt.n, 0) AS n,
             CASE WHEN m.p = '' THEN 'MISSING'
                  WHEN length(m.p) < 10 OR m.p = repeat(left(m.p, 1), length(m.p)) THEN 'INVALID'
                  WHEN cnt.n > ${SHARED_PHONE_LIMIT} THEN 'SHARED'
                  ELSE 'OK' END AS status
        FROM m LEFT JOIN cnt ON cnt.p = m.p
       WHERE upper(trim(m.act)) <> 'N'
    )`;

  async phoneQualitySummary() {
    const [counts, shared]: any[][] = await Promise.all([
      this.ds.query(`${MobileAdminService.PHONE_CTE} SELECT status, count(*)::int AS n FROM q GROUP BY status`),
      this.ds.query(`${MobileAdminService.PHONE_CTE} SELECT p AS phone, count(*)::int AS members FROM q WHERE status = 'SHARED' GROUP BY p ORDER BY members DESC LIMIT 10`),
    ]);
    const by = Object.fromEntries(counts.map((r) => [r.status, Number(r.n)]));
    const total = counts.reduce((sum, r) => sum + Number(r.n), 0);
    const ok = by.OK ?? 0;
    return {
      activeMembers: total,
      ok,
      missing: by.MISSING ?? 0,
      invalid: by.INVALID ?? 0,
      shared: by.SHARED ?? 0,
      canSelfActivate: ok, // members whose registered phone can be used for the staff call-back
      sharedNumbers: shared.map((r) => ({ phone: r.phone, members: Number(r.members) })),
    };
  }

  async phoneQualityMembers(status: string, offset = 0, limit = 100) {
    const st = ['MISSING', 'INVALID', 'SHARED'].includes(status) ? status : 'MISSING';
    const size = Math.min(Math.max(Math.trunc(limit) || 100, 1), 200);
    const rows: any[] = await this.ds.query(
      `${MobileAdminService.PHONE_CTE} SELECT mbno::text AS mbno, name, p AS phone, n::int AS shared_count FROM q WHERE status = $1 ORDER BY p, mbno LIMIT $2 OFFSET $3`,
      [st, size, Math.max(0, Math.trunc(offset) || 0)],
    );
    return rows.map((r) => ({ mbno: r.mbno, name: r.name || '', phone: r.phone || null, sharedCount: Number(r.shared_count) }));
  }

  // ───────────── activation requests ─────────────

  async listRequests(status?: string) {
    const rows: any[] = await this.ds.query(
      `SELECT r.id, r.mbno::text AS mbno, r.status, r.match_result, r.created_at, r.handled_by, r.handled_at, r.note,
              COALESCE(NULLIF(trim(m.full_name), ''), trim(concat_ws(' ', m.f_name, m.m_name, m.l_name))) AS name
         FROM mobile_activation_request r
         LEFT JOIN member_master m ON m.mbno = r.mbno
        WHERE ($1::text IS NULL OR r.status = $1)
        ORDER BY (r.status IN ('NEW','CALLED_BACK')) DESC, r.created_at DESC LIMIT 100`,
      [status && status !== 'ALL' ? status : null],
    );
    const out = [];
    for (const r of rows) {
      const member = await this.directory.getMember(r.mbno);
      out.push({
        id: Number(r.id),
        mbno: r.mbno,
        name: r.name || '',
        status: r.status,
        match: r.match_result,
        phone: member?.phone10 ?? null, // for the call-back
        createdAt: r.created_at,
        handledBy: r.handled_by,
        handledAt: r.handled_at,
        note: r.note,
      });
    }
    return out;
  }

  private async getRequest(id: number) {
    const r: any[] = await this.ds.query(`SELECT id, mbno::text AS mbno, status FROM mobile_activation_request WHERE id = $1`, [id]);
    if (!r.length) throw new NotFoundException('Request not found');
    return r[0];
  }

  async markCalledBack(id: number, staff: string, note?: string) {
    const r = await this.getRequest(id);
    if (!['NEW', 'CALLED_BACK'].includes(r.status)) throw new BadRequestException('This request is already closed');
    await this.ds.query(`UPDATE mobile_activation_request SET status = 'CALLED_BACK', handled_by = $2, handled_at = now(), note = COALESCE($3, note) WHERE id = $1`, [id, staff, note?.slice(0, 500) ?? null]);
    await this.audit.log({ event: 'ACTIVATION_REQUEST_CALLBACK', result: 'OK', mbno: r.mbno, detail: { by: staff, id } });
    return { status: 'CALLED_BACK' };
  }

  /** Approve = staff are satisfied after the call-back: issue the code (shown once, to be read to the member). */
  async approveRequest(id: number, staff: string) {
    const r = await this.getRequest(id);
    if (!['NEW', 'CALLED_BACK'].includes(r.status)) throw new BadRequestException('This request is already closed');
    const issued = await this.activation.issueCode(r.mbno, staff);
    await this.ds.query(`UPDATE mobile_activation_request SET status = 'APPROVED', handled_by = $2, handled_at = now() WHERE id = $1`, [id, staff]);
    await this.audit.log({ event: 'ACTIVATION_REQUEST_APPROVED', result: 'OK', mbno: r.mbno, detail: { by: staff, id } });
    return issued;
  }

  async rejectRequest(id: number, staff: string, note?: string) {
    const r = await this.getRequest(id);
    if (!['NEW', 'CALLED_BACK'].includes(r.status)) throw new BadRequestException('This request is already closed');
    await this.ds.query(`UPDATE mobile_activation_request SET status = 'REJECTED', handled_by = $2, handled_at = now(), note = COALESCE($3, note) WHERE id = $1`, [id, staff, note?.slice(0, 500) ?? null]);
    // No other open request and never activated: go back to "not activated".
    await this.ds.query(
      `UPDATE mobile_account SET status = 'NOT_ACTIVATED', updated_at = now()
        WHERE mbno = $1 AND status = 'REQUEST_PENDING'
          AND NOT EXISTS (SELECT 1 FROM mobile_activation_request WHERE mbno = $1 AND status IN ('NEW','CALLED_BACK'))`,
      [r.mbno],
    );
    await this.audit.log({ event: 'ACTIVATION_REQUEST_REJECTED', result: 'OK', mbno: r.mbno, detail: { by: staff, id } });
    return { status: 'REJECTED' };
  }
}
