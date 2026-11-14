import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as net from 'net';
import { DataSource } from 'typeorm';
import { sha256 } from '../access/mobile-crypto';
import { MobileAuditService } from '../audit/mobile-audit.service';
import { MOBILE_DS } from '../mobile.constants';

export type BlockKind = 'IP' | 'DEVICE';

/**
 * Blocks a phone or an internet address from the member app (ES-243). A blocked caller gets 403 ACCESS_BLOCKED from every
 * /mobile route before any work is done. The list is cached for 15 seconds, so a new block takes effect within that time.
 * Phones are blocked by the SHA-256 device hash (the same value the audit trail shows), never by the raw device id.
 * Staff are never affected: only controllers that use MobileThrottlerGuard (the /mobile routes) call isBlocked().
 */
@Injectable()
export class BlocklistService {
  private cache: { at: number; ips: Set<string>; devices: Set<string> } | null = null;
  private static readonly TTL_MS = 15_000;

  constructor(
    @InjectDataSource(MOBILE_DS) private readonly ds: DataSource,
    private readonly audit: MobileAuditService,
  ) {}

  private async load() {
    const now = Date.now();
    if (this.cache && now - this.cache.at < BlocklistService.TTL_MS) return this.cache;
    const rows: Array<{ kind: string; value: string }> = await this.ds.query(`SELECT kind, value FROM mobile_blocklist WHERE unblocked_at IS NULL`);
    this.cache = {
      at: now,
      ips: new Set(rows.filter((r) => r.kind === 'IP').map((r) => r.value)),
      devices: new Set(rows.filter((r) => r.kind === 'DEVICE').map((r) => r.value)),
    };
    return this.cache;
  }

  /** `ip` as Express shows it (an IPv4 address may come as ::ffff:1.2.3.4); `rawDeviceId` is the X-Device-Id header. */
  async isBlocked(ip?: string, rawDeviceId?: string): Promise<boolean> {
    try {
      const c = await this.load();
      if (ip && c.ips.has(BlocklistService.normaliseIp(ip))) return true;
      if (rawDeviceId && c.devices.has(sha256(rawDeviceId))) return true;
      return false;
    } catch {
      return false; // a database hiccup must not lock every member out
    }
  }

  static normaliseIp(ip: string): string {
    return ip.replace(/^::ffff:/i, '').trim().toLowerCase();
  }

  async list(): Promise<Array<{ id: number; kind: BlockKind; value: string; reason: string | null; blockedBy: string | null; blockedAt: string }>> {
    const rows: any[] = await this.ds.query(`SELECT id, kind, value, reason, blocked_by, blocked_at FROM mobile_blocklist WHERE unblocked_at IS NULL ORDER BY blocked_at DESC`);
    return rows.map((r) => ({ id: Number(r.id), kind: r.kind, value: r.value, reason: r.reason, blockedBy: r.blocked_by, blockedAt: new Date(r.blocked_at).toISOString() }));
  }

  /** `value` is an IP address (kind IP) or a 64-character device hash copied from the audit trail (kind DEVICE). */
  async block(kind: BlockKind, value: string, reason: string, staff: string): Promise<{ id: number }> {
    let v = String(value || '').trim().toLowerCase();
    if (kind === 'IP') {
      v = BlocklistService.normaliseIp(v);
      if (!net.isIP(v)) throw new BadRequestException('That is not a valid IP address');
    } else if (kind === 'DEVICE') {
      if (!/^[0-9a-f]{64}$/.test(v)) throw new BadRequestException('A device is blocked by its device reference (64 characters), copied from the audit trail');
    } else {
      throw new BadRequestException('kind must be IP or DEVICE');
    }
    const dup: any[] = await this.ds.query(`SELECT id FROM mobile_blocklist WHERE kind = $1 AND value = $2 AND unblocked_at IS NULL`, [kind, v]);
    if (dup.length) throw new BadRequestException('Already blocked');
    const rows: any[] = await this.ds.query(
      `INSERT INTO mobile_blocklist (kind, value, reason, blocked_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [kind, v, reason.slice(0, 300), staff.slice(0, 100)],
    );
    this.cache = null;
    await this.audit.log({ event: 'STAFF_BLOCK_' + kind, result: 'OK', detail: { by: staff, value: kind === 'DEVICE' ? v.slice(0, 12) : v, reason: reason.slice(0, 300) } });
    return { id: Number(rows[0].id) };
  }

  async unblock(id: number, staff: string): Promise<{ unblocked: true }> {
    const rows: any[] = await this.ds.query(
      `UPDATE mobile_blocklist SET unblocked_at = now(), unblocked_by = $2 WHERE id = $1 AND unblocked_at IS NULL RETURNING kind, value`,
      [id, staff.slice(0, 100)],
    );
    const hit = Array.isArray(rows[0]) ? rows[0] : rows;
    if (!hit.length) throw new NotFoundException('That block does not exist or was already lifted');
    this.cache = null;
    await this.audit.log({ event: 'STAFF_UNBLOCK_' + hit[0].kind, result: 'OK', detail: { by: staff, value: hit[0].kind === 'DEVICE' ? String(hit[0].value).slice(0, 12) : hit[0].value } });
    return { unblocked: true };
  }
}
