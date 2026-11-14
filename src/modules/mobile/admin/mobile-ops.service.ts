import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MobileAuditService } from '../audit/mobile-audit.service';
import { FeatureFlagService } from '../data/feature-flag.service';
import { MOBILE_DS } from '../mobile.constants';
import { sha256 } from '../access/mobile-crypto';

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
export const PLATFORMS = ['android', 'ios'] as const;

/** 1.10.0 > 1.9.0: compares x.y.z numerically (plain text comparison would get this wrong). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** A CSV cell that cannot run as a spreadsheet formula (cells starting with = + - @ are prefixed with a quote). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface AuditFilter {
  mbno?: string;
  event?: string;
  result?: string;
  ip?: string;
  deviceId?: string; // the raw device id a member reads out, or the 64-character hash from the audit trail
  from?: string; // YYYY-MM-DD
  to?: string;
  limit?: number;
  offset?: number;
}

/** Control Center: Features and releases (ES-241) and Security and audit (ES-243). */
@Injectable()
export class MobileOpsService {
  constructor(
    @InjectDataSource(MOBILE_DS) private readonly ds: DataSource,
    private readonly flags: FeatureFlagService,
    private readonly audit: MobileAuditService,
  ) {}

  // ───────────── features and releases (ES-241) ─────────────

  async features() {
    const [flags, versions, settings] = await Promise.all([
      this.ds.query(`SELECT key, enabled, description, updated_by, updated_at FROM mobile_feature_flag ORDER BY key`),
      this.ds.query(`SELECT platform, latest_version, min_supported_version, store_url, message, updated_by, updated_at FROM mobile_app_version ORDER BY platform`),
      this.ds.query(`SELECT key, value FROM mobile_setting WHERE key IN ('maintenance_enabled', 'maintenance_message')`),
    ]);
    const s = Object.fromEntries((settings as any[]).map((r) => [r.key, r.value]));
    return {
      flags: (flags as any[]).map((r) => ({ key: r.key, enabled: !!r.enabled, description: r.description, updatedBy: r.updated_by, updatedAt: new Date(r.updated_at).toISOString() })),
      versions: (versions as any[]).map((r) => ({
        platform: r.platform, latestVersion: r.latest_version, minSupportedVersion: r.min_supported_version, storeUrl: r.store_url, message: r.message,
        updatedBy: r.updated_by, updatedAt: new Date(r.updated_at).toISOString(),
      })),
      maintenance: { enabled: String(s.maintenance_enabled).toLowerCase() === 'true', message: s.maintenance_message || '' },
    };
  }

  /** Only existing switches can be changed (a typo cannot create a new one, and a missing switch counts as OFF). */
  async setFlag(key: string, enabled: boolean, staff: string): Promise<{ key: string; enabled: boolean }> {
    const rows: any[] = await this.ds.query(`UPDATE mobile_feature_flag SET enabled = $2, updated_by = $3, updated_at = now() WHERE key = $1 RETURNING key`, [key, enabled, staff.slice(0, 100)]);
    if (!(Array.isArray(rows[0]) ? rows[0] : rows).length) throw new NotFoundException('There is no such feature switch');
    this.flags.clear();
    await this.audit.log({ event: 'STAFF_FEATURE_FLAG', result: 'OK', detail: { by: staff, key, enabled } });
    return { key, enabled };
  }

  async setVersion(platform: string, v: { latestVersion: string; minSupportedVersion: string; storeUrl?: string; message?: string }, staff: string) {
    if (!(PLATFORMS as readonly string[]).includes(platform)) throw new BadRequestException('platform must be android or ios');
    if (!VERSION.test(v.latestVersion) || !VERSION.test(v.minSupportedVersion)) throw new BadRequestException('Versions look like 1.2.3');
    if (compareVersions(v.minSupportedVersion, v.latestVersion) > 0) throw new BadRequestException('The lowest allowed version cannot be newer than the latest version');
    if (v.storeUrl && !/^https:\/\/[^\s]{3,280}$/.test(v.storeUrl)) throw new BadRequestException('The store link must start with https://');
    await this.ds.query(
      `INSERT INTO mobile_app_version (platform, latest_version, min_supported_version, store_url, message, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (platform) DO UPDATE SET latest_version = $2, min_supported_version = $3, store_url = $4, message = $5, updated_by = $6, updated_at = now()`,
      [platform, v.latestVersion, v.minSupportedVersion, v.storeUrl ?? null, (v.message ?? '').slice(0, 300) || null, staff.slice(0, 100)],
    );
    await this.audit.log({ event: 'STAFF_APP_VERSION', result: 'OK', detail: { by: staff, platform, latest: v.latestVersion, min: v.minSupportedVersion } });
    return { platform };
  }

  async setMaintenance(enabled: boolean, message: string, staff: string) {
    const msg = (message ?? '').slice(0, 300);
    await this.ds.query(
      `INSERT INTO mobile_setting (key, value, updated_by, updated_at) VALUES ('maintenance_enabled', $1, $3, now()), ('maintenance_message', $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [String(enabled), msg, staff.slice(0, 100)],
    );
    await this.audit.log({ event: 'STAFF_MAINTENANCE', result: 'OK', detail: { by: staff, enabled } });
    return { enabled, message: msg };
  }

  // ───────────── security and audit (ES-243) ─────────────

  private where(f: AuditFilter): { sql: string; params: unknown[] } {
    const c: string[] = [];
    const p: unknown[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); c.push(sql.replace('?', `$${p.length}`)); };
    if (f.mbno) {
      if (!/^\d{1,18}$/.test(f.mbno)) throw new BadRequestException('Invalid member number');
      add('mbno = ?', f.mbno);
    }
    if (f.event) add('event = ?', f.event.slice(0, 60));
    if (f.result) add('result = ?', f.result.slice(0, 20));
    if (f.ip) add('ip = ?', f.ip.slice(0, 64));
    if (f.deviceId) add('device_id_hash = ?', /^[0-9a-f]{64}$/i.test(f.deviceId) ? f.deviceId.toLowerCase() : sha256(f.deviceId));
    if (f.from) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.from)) throw new BadRequestException('from must be YYYY-MM-DD');
      add(`at >= (?::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`, f.from);
    }
    if (f.to) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.to)) throw new BadRequestException('to must be YYYY-MM-DD');
      add(`at < ((?::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`, f.to);
    }
    return { sql: c.length ? 'WHERE ' + c.join(' AND ') : '', params: p };
  }

  async auditSearch(f: AuditFilter) {
    const { sql, params } = this.where(f);
    const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 200);
    const offset = Math.max(Number(f.offset) || 0, 0);
    const rows: any[] = await this.ds.query(
      `SELECT id, at, mbno::text AS mbno, event, result, method, endpoint, status_code, device_id_hash, ip, app_version, platform, detail
         FROM mobile_audit_log ${sql} ORDER BY at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return rows.map((r) => ({
      id: Number(r.id), at: new Date(r.at).toISOString(), mbno: r.mbno, event: r.event, result: r.result, method: r.method, endpoint: r.endpoint,
      statusCode: r.status_code, deviceRef: r.device_id_hash, ip: r.ip, appVersion: r.app_version, platform: r.platform, detail: r.detail,
    }));
  }

  /** Read-only export of the same filter as CSV (at most 5000 rows). */
  async auditCsv(f: AuditFilter, staff: string): Promise<string> {
    const { sql, params } = this.where(f);
    const rows: any[] = await this.ds.query(
      `SELECT at, mbno::text AS mbno, event, result, endpoint, status_code, device_id_hash, ip, app_version, platform, detail
         FROM mobile_audit_log ${sql} ORDER BY at DESC, id DESC LIMIT 5000`,
      params,
    );
    await this.audit.log({ event: 'STAFF_AUDIT_EXPORT', result: 'OK', detail: { by: staff, rows: rows.length } });
    const head = ['time', 'member', 'event', 'result', 'endpoint', 'status', 'device', 'ip', 'app version', 'platform', 'detail'];
    const lines = rows.map((r) => [new Date(r.at).toISOString(), r.mbno, r.event, r.result, r.endpoint, r.status_code, r.device_id_hash, r.ip, r.app_version, r.platform, r.detail].map(csvCell).join(','));
    return [head.join(','), ...lines].join('\r\n') + '\r\n';
  }

  /** Last 24 hours at a glance: who is failing to sign in, from where, and how many accounts are locked. */
  async monitors() {
    const q = (sql: string) => this.ds.query(sql) as Promise<any[]>;
    const [totals, byIp, byMember, locked, blocked] = await Promise.all([
      q(`SELECT
           count(*) FILTER (WHERE event = 'LOGIN' AND result = 'FAIL')::int           AS login_failed,
           count(*) FILTER (WHERE event = 'LOGIN' AND result = 'OK')::int             AS login_ok,
           count(*) FILTER (WHERE event = 'STEP_UP' AND result = 'FAIL')::int         AS appcode_failed,
           count(*) FILTER (WHERE event = 'ACTIVATE' AND result = 'FAIL')::int        AS activation_failed,
           count(*) FILTER (WHERE event = 'MPIN_LOCKED')::int                         AS lockouts,
           count(*) FILTER (WHERE event = 'REFRESH_REUSE')::int                       AS token_reuse
         FROM mobile_audit_log WHERE at > now() - interval '24 hours'`),
      q(`SELECT ip, count(*)::int AS n, count(DISTINCT mbno)::int AS members FROM mobile_audit_log
          WHERE at > now() - interval '24 hours' AND result = 'FAIL' AND event IN ('LOGIN', 'ACTIVATE', 'STEP_UP') AND ip IS NOT NULL
          GROUP BY ip ORDER BY n DESC LIMIT 10`),
      q(`SELECT mbno::text AS mbno, count(*)::int AS n FROM mobile_audit_log
          WHERE at > now() - interval '24 hours' AND result = 'FAIL' AND event IN ('LOGIN', 'ACTIVATE', 'STEP_UP') AND mbno IS NOT NULL
          GROUP BY mbno ORDER BY n DESC LIMIT 10`),
      q(`SELECT count(*)::int AS n FROM mobile_account WHERE status = 'LOCKED'`),
      q(`SELECT count(*)::int AS n FROM mobile_blocklist WHERE unblocked_at IS NULL`),
    ]);
    const t = totals[0];
    return {
      last24h: { loginFailed: t.login_failed, loginOk: t.login_ok, appCodeFailed: t.appcode_failed, activationFailed: t.activation_failed, lockouts: t.lockouts, tokenReuse: t.token_reuse },
      topFailingIps: byIp.map((r) => ({ ip: r.ip, failures: r.n, members: r.members })),
      topFailingMembers: byMember.map((r) => ({ mbno: r.mbno, failures: r.n })),
      lockedAccounts: locked[0].n,
      activeBlocks: blocked[0].n,
    };
  }
}
