import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { RETIREMENT_DATE_RECORDED_SQL } from '../member-status/member-status.service';

/**
 * Notification Centre (ES-101).
 *
 * Detectors look at the live data and write one row per real-world condition into system_notifications
 * (dedupe_key makes a re-check update the row instead of duplicating it). A condition that no longer holds
 * is marked RESOLVED. Read state is kept per user. The bell in the title bar is unchanged; it just also
 * shows how many of these are unread.
 */
export type NotificationKind =
  | 'MEMBER_READY_INACTIVE' | 'MEMBER_RETIRING_SOON' | 'INSURANCE_DUE'
  | 'MEMBER_NO_RETIREMENT_DATE' | 'NEGATIVE_RD' | 'MESSAGES_FAILED' | 'MESSAGES_PENDING' | 'DAYEND_PENDING';

interface Desired {
  kind: NotificationKind;
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  mbno?: string | null;
  member_name?: string | null;
  action_path?: string | null;
  action_label?: string | null;
  dedupe_key: string;
}

const MEMBER_STATUS_PATH = '/masters/member-status';
const fmtDate = (d: string) => { const [y, m, day] = String(d).slice(0, 10).split('-'); return `${day}-${m}-${y}`; };
const inr = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

@Injectable()
export class NotificationCentreService {
  private readonly logger = new Logger(NotificationCentreService.name);
  private lastSync = 0;
  private syncing: Promise<{ open: number; resolved: number }> | null = null;

  constructor(private readonly dataSource: DataSource) {}

  // ── detectors ──────────────────────────────────────────────────────────────
  private async detect(): Promise<Desired[]> {
    const out: Desired[] = [];

    // 1. Members who have retired and whose RD is zero — ready to be marked inactive (ES-100)
    const ready = await this.dataSource.query(`
      SELECT m.mbno::text AS mbno,
             COALESCE(NULLIF(m.full_name,''), NULLIF(trim(concat_ws(' ', m.f_name, m.m_name, m.l_name)), ''), '') AS name,
             to_char(m.date_of_retirement, 'YYYY-MM-DD') AS retired_on
        FROM member_master m
        LEFT JOIN (SELECT mbno::numeric AS mbno, sum(compulsory_deposit) AS cd FROM member_balances GROUP BY 1) b ON b.mbno = m.mbno::numeric
       WHERE m.isactive = 'Y' AND ${RETIREMENT_DATE_RECORDED_SQL('m.date_of_retirement')} AND m.date_of_retirement::date <= current_date
         AND COALESCE(b.cd, 0) <= 0
       ORDER BY m.mbno`);
    for (const r of ready) {
      out.push({
        kind: 'MEMBER_READY_INACTIVE', severity: 'warning', dedupe_key: `ready:${r.mbno}`,
        title: `${r.name || 'Member'} (${r.mbno}) can be marked inactive`,
        body: `Retired on ${fmtDate(r.retired_on)} and the RD balance is zero. Both conditions are met; a person has to mark the member inactive.`,
        mbno: r.mbno, member_name: r.name, action_path: MEMBER_STATUS_PATH, action_label: 'Open Member Status',
      });
    }

    // 2. Members about to retire (next 90 days)
    const soon = await this.dataSource.query(`
      SELECT m.mbno::text AS mbno,
             COALESCE(NULLIF(m.full_name,''), NULLIF(trim(concat_ws(' ', m.f_name, m.m_name, m.l_name)), ''), '') AS name,
             to_char(m.date_of_retirement, 'YYYY-MM-DD') AS retires_on,
             (m.date_of_retirement::date - current_date) AS days_left,
             COALESCE(b.cd, 0)::float AS rd
        FROM member_master m
        LEFT JOIN (SELECT mbno::numeric AS mbno, sum(compulsory_deposit) AS cd FROM member_balances GROUP BY 1) b ON b.mbno = m.mbno::numeric
       WHERE m.isactive = 'Y' AND ${RETIREMENT_DATE_RECORDED_SQL('m.date_of_retirement')}
         AND m.date_of_retirement::date > current_date AND m.date_of_retirement::date <= current_date + 90
       ORDER BY m.date_of_retirement, m.mbno`);
    for (const r of soon) {
      out.push({
        kind: 'MEMBER_RETIRING_SOON', severity: r.days_left <= 30 ? 'warning' : 'info', dedupe_key: `retiring:${r.mbno}`,
        title: `${r.name || 'Member'} (${r.mbno}) retires in ${r.days_left} day${r.days_left === 1 ? '' : 's'}`,
        body: `Retirement date ${fmtDate(r.retires_on)}. RD balance is ${inr(r.rd)}${r.rd <= 0 ? ', so the member can be marked inactive after retirement' : '; the member becomes inactive only once the RD reaches zero'}.`,
        mbno: r.mbno, member_name: r.name, action_path: MEMBER_STATUS_PATH, action_label: 'Open Member Status',
      });
    }

    // 2b. Active members with no usable retirement date (empty, or the legacy 01-01-1900 placeholder). They are treated as
    // not retired, so they are charged insurance and never flagged for inactivation until a real date is entered.
    const noDate = await this.dataSource.query(`
      SELECT count(*)::int AS n FROM member_master m
       WHERE m.isactive = 'Y' AND NOT ${RETIREMENT_DATE_RECORDED_SQL('m.date_of_retirement')}`);
    if (noDate[0]?.n > 0) {
      out.push({
        kind: 'MEMBER_NO_RETIREMENT_DATE', severity: 'info', dedupe_key: 'no-retirement-date',
        title: `${noDate[0].n.toLocaleString('en-IN')} active members have no retirement date recorded`,
        body: 'Their date is empty or the old 01-01-1900 placeholder, so they are treated as not retired: they are charged group insurance and are never flagged to be marked inactive. Enter the real date in Member Master.',
        action_path: '/masters/member', action_label: 'Open Member Master',
      });
    }

    // 3. Group insurance not posted for the current financial year, and the year is ending (or over)
    const fy = await this.dataSource.query(`
      SELECT y.yearcode, to_char((y.start_date + interval '12 hours')::date, 'YYYY-MM-DD') AS fy_start,
             to_char((y.end_date + interval '12 hours')::date, 'YYYY-MM-DD') AS fy_end,
             ((y.end_date + interval '12 hours')::date - current_date) AS days_left,
             EXISTS (SELECT 1 FROM group_insurance_run r WHERE r.yearcode = y.yearcode AND r.status = 'POSTED') AS posted
        FROM yearend y
       WHERE (y.start_date + interval '12 hours')::date <= current_date AND current_date <= (y.end_date + interval '12 hours')::date + 60
       ORDER BY y.yearcode LIMIT 1`);
    if (fy[0] && !fy[0].posted && fy[0].days_left <= 60) {
      const label = `${fy[0].fy_start.slice(0, 4)}-${String((Number(fy[0].fy_start.slice(0, 4)) + 1) % 100).padStart(2, '0')}`;
      const over = fy[0].days_left < 0;
      out.push({
        kind: 'INSURANCE_DUE', severity: over ? 'error' : 'warning', dedupe_key: `insurance:${fy[0].yearcode}`,
        title: `Group insurance for ${label} has not been posted`,
        body: over
          ? `The financial year ended on ${fmtDate(fy[0].fy_end)}. The yearly insurance deduction from RD is still pending.`
          : `The financial year ends on ${fmtDate(fy[0].fy_end)} (${fy[0].days_left} day${fy[0].days_left === 1 ? '' : 's'} left). The yearly insurance deduction from RD is normally posted in March.`,
        action_path: '/administration/group-insurance', action_label: 'Open Group Insurance',
      });
    }

    // 4. Members whose RD is negative (after the insurance deduction) — recovered at the next loan / new-year deposits
    const neg = await this.dataSource.query(`
      SELECT count(*)::int AS n, COALESCE(sum(-cd), 0)::float AS total
        FROM (SELECT mbno, sum(compulsory_deposit) AS cd FROM member_balances GROUP BY mbno) t WHERE cd < 0`);
    if (neg[0]?.n > 0) {
      out.push({
        kind: 'NEGATIVE_RD', severity: 'warning', dedupe_key: 'negative-rd',
        title: `${neg[0].n.toLocaleString('en-IN')} member${neg[0].n === 1 ? ' has' : 's have'} a negative RD balance`,
        body: `${inr(neg[0].total)} in all. It is recovered from the member's next loan and from the first RD deposits of the new financial year.`,
      });
    }

    // 5. Message delivery (existing Communication Hub log)
    const msg = await this.dataSource.query(`
      SELECT count(*) FILTER (WHERE status::text = 'FAILED' AND "createdAt" > now() - interval '7 days')::int AS failed,
             count(*) FILTER (WHERE status::text = 'PENDING' AND "createdAt" < now() - interval '1 hour')::int AS pending
        FROM notification_logs`);
    if (msg[0]?.failed > 0) {
      out.push({
        kind: 'MESSAGES_FAILED', severity: 'error', dedupe_key: 'msg-failed',
        title: `${msg[0].failed} message${msg[0].failed === 1 ? '' : 's'} to members failed in the last 7 days`,
        body: 'SMS / WhatsApp messages could not be delivered. Open the Communication Hub to see the reason and retry.',
        action_path: '/utility/communication-center', action_label: 'Open Communication Hub',
      });
    }
    if (msg[0]?.pending > 0) {
      out.push({
        kind: 'MESSAGES_PENDING', severity: 'info', dedupe_key: 'msg-pending',
        title: `${msg[0].pending} message${msg[0].pending === 1 ? ' is' : 's are'} still waiting to be delivered`,
        body: 'Queued for more than an hour without being sent.',
        action_path: '/utility/communication-center', action_label: 'Open Communication Hub',
      });
    }

    // 6. Day-end behind the calendar
    const wd = await this.dataSource.query(`
      SELECT to_char(working_date::date, 'YYYY-MM-DD') AS working_date, (current_date - working_date::date) AS behind
        FROM getworkingdate ORDER BY working_date DESC LIMIT 1`);
    if (wd[0] && wd[0].behind >= 2) {
      out.push({
        kind: 'DAYEND_PENDING', severity: 'warning', dedupe_key: 'dayend',
        title: `The working date is ${wd[0].behind} days behind today`,
        body: `The working date is ${fmtDate(wd[0].working_date)}. Complete the Day End to move it forward.`,
        action_path: '/day-end', action_label: 'Open Day End',
      });
    }

    return out;
  }

  // ── sync ───────────────────────────────────────────────────────────────────
  async sync(): Promise<{ open: number; resolved: number }> {
    if (this.syncing) return this.syncing; // a run is already in progress — share its result
    this.syncing = this.doSync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async doSync() {
    const desired = await this.detect();
    const keys = desired.map(d => d.dedupe_key);
    const rows = JSON.stringify(desired.map(d => ({
      kind: d.kind, severity: d.severity, title: d.title.slice(0, 200), body: d.body, mbno: d.mbno ?? null,
      member_name: d.member_name ? d.member_name.slice(0, 200) : null, action_path: d.action_path ?? null,
      action_label: d.action_label ?? null, dedupe_key: d.dedupe_key,
    })));

    const result = await this.dataSource.transaction(async (em) => {
      // a condition that comes back after being resolved shows up as unread again
      await em.query(
        `DELETE FROM system_notification_reads WHERE notification_id IN
           (SELECT id FROM system_notifications WHERE status = 'RESOLVED' AND dedupe_key = ANY($1::text[]))`, [keys]);
      await em.query(`
        INSERT INTO system_notifications (kind, severity, title, body, mbno, member_name, action_path, action_label, dedupe_key)
        SELECT x.kind, x.severity, x.title, x.body, x.mbno, x.member_name, x.action_path, x.action_label, x.dedupe_key
          FROM jsonb_to_recordset($1::jsonb) AS x(kind text, severity text, title text, body text, mbno numeric,
                                                   member_name text, action_path text, action_label text, dedupe_key text)
        ON CONFLICT (dedupe_key) DO UPDATE SET
          kind = EXCLUDED.kind, severity = EXCLUDED.severity, title = EXCLUDED.title, body = EXCLUDED.body,
          mbno = EXCLUDED.mbno, member_name = EXCLUDED.member_name, action_path = EXCLUDED.action_path,
          action_label = EXCLUDED.action_label, updated_at = now(),
          created_at = CASE WHEN system_notifications.status = 'RESOLVED' THEN now() ELSE system_notifications.created_at END,
          status = 'OPEN', resolved_at = NULL`, [rows]);
      const res = await em.query(
        `UPDATE system_notifications SET status = 'RESOLVED', resolved_at = now(), updated_at = now()
          WHERE status = 'OPEN' AND dedupe_key <> ALL($1::text[]) RETURNING id`, [keys]);
      return { open: desired.length, resolved: Array.isArray(res[0]) ? res[0].length : res.length };
    });
    this.lastSync = Date.now();
    return result;
  }

  private async ensureFresh(maxAgeMs = 10 * 60_000) {
    if (Date.now() - this.lastSync > maxAgeMs) {
      try { await this.sync(); } catch (e) { this.logger.warn(`Notification sync failed: ${(e as Error).message}`); }
    }
  }

  @Cron('0 */30 * * * *')
  async scheduledSync() {
    try { await this.sync(); } catch (e) { this.logger.warn(`Scheduled notification sync failed: ${(e as Error).message}`); }
  }

  // ── reads ──────────────────────────────────────────────────────────────────
  async summary(username: string) {
    await this.ensureFresh();
    const [row] = await this.dataSource.query(`
      SELECT count(*)::int AS open,
             count(*) FILTER (WHERE r.notification_id IS NULL)::int AS unread,
             count(*) FILTER (WHERE n.severity = 'error')::int AS errors,
             count(*) FILTER (WHERE n.severity = 'warning')::int AS warnings,
             count(*) FILTER (WHERE n.severity = 'info')::int AS infos
        FROM system_notifications n
        LEFT JOIN system_notification_reads r ON r.notification_id = n.id AND r.username = $1
       WHERE n.status = 'OPEN'`, [username]);
    const kinds = await this.dataSource.query(`
      SELECT n.kind, count(*)::int AS total, count(*) FILTER (WHERE r.notification_id IS NULL)::int AS unread
        FROM system_notifications n
        LEFT JOIN system_notification_reads r ON r.notification_id = n.id AND r.username = $1
       WHERE n.status = 'OPEN' GROUP BY n.kind`, [username]);
    return {
      open: row.open, unread: row.unread, bySeverity: { error: row.errors, warning: row.warnings, info: row.infos },
      byKind: Object.fromEntries(kinds.map((k: any) => [k.kind, { total: k.total, unread: k.unread }])),
      lastSyncedAt: this.lastSync ? new Date(this.lastSync).toISOString() : null,
    };
  }

  async list(username: string, o: {
    status?: string; kind?: string; severity?: string; unreadOnly?: boolean; search?: string; limit?: number; offset?: number;
  }) {
    await this.ensureFresh();
    const status = o.status === 'resolved' ? 'RESOLVED' : o.status === 'all' ? null : 'OPEN';
    const limit = Math.min(200, Math.max(1, Math.floor(Number(o.limit) || 50)));
    const offset = Math.max(0, Math.floor(Number(o.offset) || 0));
    const params: any[] = [username];
    const where: string[] = [];
    if (status) { params.push(status); where.push(`n.status = $${params.length}`); }
    if (o.kind) { params.push(o.kind); where.push(`n.kind = $${params.length}`); }
    if (o.severity) { params.push(o.severity); where.push(`n.severity = $${params.length}`); }
    if (o.unreadOnly) where.push('r.notification_id IS NULL');
    if ((o.search || '').trim()) {
      params.push(`%${o.search!.trim()}%`);
      where.push(`(n.title ILIKE $${params.length} OR n.body ILIKE $${params.length} OR n.mbno::text ILIKE $${params.length})`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM system_notifications n LEFT JOIN system_notification_reads r ON r.notification_id = n.id AND r.username = $1 ${w}`;
    const [{ total }] = await this.dataSource.query(`SELECT count(*)::int AS total ${from}`, params);
    const rows = await this.dataSource.query(`
      SELECT n.id, n.kind, n.severity, n.title, n.body, n.mbno::text AS mbno, n.member_name, n.action_path, n.action_label,
             n.status, n.created_at, n.updated_at, n.resolved_at, (r.notification_id IS NOT NULL) AS read
        ${from}
       ORDER BY CASE n.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, n.created_at DESC, n.id DESC
       LIMIT ${limit} OFFSET ${offset}`, params);
    return {
      total, limit, offset,
      rows: rows.map((r: any) => ({
        id: r.id, kind: r.kind, severity: r.severity, title: r.title, body: r.body, memberNo: r.mbno, memberName: r.member_name,
        actionPath: r.action_path, actionLabel: r.action_label, status: r.status, createdAt: r.created_at,
        updatedAt: r.updated_at, resolvedAt: r.resolved_at, read: r.read,
      })),
    };
  }

  async markRead(id: number, username: string) {
    const found = await this.dataSource.query(`SELECT 1 FROM system_notifications WHERE id = $1`, [id]);
    if (!found.length) throw new NotFoundException('Notification not found');
    await this.dataSource.query(
      `INSERT INTO system_notification_reads (notification_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, username]);
    return { id, read: true };
  }

  async markUnread(id: number, username: string) {
    await this.dataSource.query(`DELETE FROM system_notification_reads WHERE notification_id = $1 AND username = $2`, [id, username]);
    return { id, read: false };
  }

  async markAllRead(username: string, kind?: string) {
    const res = await this.dataSource.query(`
      INSERT INTO system_notification_reads (notification_id, username)
      SELECT n.id, $1 FROM system_notifications n
       WHERE n.status = 'OPEN' AND ($2::text IS NULL OR n.kind = $2)
      ON CONFLICT DO NOTHING RETURNING notification_id`, [username, kind || null]);
    return { marked: Array.isArray(res) ? res.length : 0 };
  }
}
