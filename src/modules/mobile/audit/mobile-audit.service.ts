import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { MOBILE_DS } from '../mobile.constants';

export interface MobileAuditEntry {
  event: string;
  mbno?: string | null;
  result?: 'OK' | 'FAIL' | string;
  method?: string;
  endpoint?: string;
  statusCode?: number;
  deviceId?: string; // raw X-Device-Id header; only its SHA-256 is stored
  ip?: string;
  requestId?: string;
  appVersion?: string;
  platform?: string;
  detail?: Record<string, unknown>;
}

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const cut = (v: unknown, n: number) => (v === undefined || v === null ? null : String(v).slice(0, n));

/**
 * Writes the mobile security / activity trail (ES-224). Auditing must never break a request, so every failure is
 * swallowed and logged. Never put OTPs, MPINs, codes, tokens or amounts in `detail`.
 */
@Injectable()
export class MobileAuditService {
  private readonly logger = new Logger(MobileAuditService.name);

  constructor(@InjectDataSource(MOBILE_DS) private readonly ds: DataSource) {}

  async log(e: MobileAuditEntry): Promise<void> {
    try {
      await this.ds.query(
        `INSERT INTO mobile_audit_log
           (mbno, event, result, method, endpoint, status_code, device_id_hash, ip, request_id, app_version, platform, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          e.mbno ?? null,
          e.event.slice(0, 60),
          cut(e.result, 20),
          cut(e.method, 10),
          cut(e.endpoint, 200),
          e.statusCode ?? null,
          e.deviceId ? sha256(e.deviceId) : null,
          cut(e.ip, 64),
          cut(e.requestId, 64),
          cut(e.appVersion, 20),
          cut(e.platform, 10),
          e.detail ? JSON.stringify(e.detail) : null,
        ],
      );
    } catch (err) {
      this.logger.warn(`audit write failed for ${e.event}: ${(err as Error).message}`);
    }
  }

  /** Fills client details (ip, device, version, request id) from an Express request. */
  fromRequest(req: any, e: Pick<MobileAuditEntry, 'event'> & Partial<MobileAuditEntry>): MobileAuditEntry {
    const h = req?.headers ?? {};
    return {
      mbno: req?.user?.kind === 'member' ? req.user.mbno : null,
      method: req?.method,
      endpoint: (req?.originalUrl ?? req?.url ?? '').split('?')[0],
      deviceId: h['x-device-id'],
      ip: req?.ip,
      requestId: h['x-request-id'],
      appVersion: h['x-app-version'],
      platform: h['x-platform'],
      ...e,
    };
  }
}
