import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MOBILE_DS } from '../mobile.constants';

/** Reads the remote switches (mobile_feature_flag) with a short cache. A missing flag counts as OFF. */
@Injectable()
export class FeatureFlagService {
  private cache: { at: number; flags: Map<string, boolean> } | null = null;
  private static readonly TTL_MS = 15_000;

  constructor(@InjectDataSource(MOBILE_DS) private readonly ds: DataSource) {}

  private async load(): Promise<Map<string, boolean>> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < FeatureFlagService.TTL_MS) return this.cache.flags;
    const rows: Array<{ key: string; enabled: boolean }> = await this.ds.query(`SELECT key, enabled FROM mobile_feature_flag`);
    this.cache = { at: now, flags: new Map(rows.map((r) => [r.key, !!r.enabled])) };
    return this.cache.flags;
  }

  async isOn(key: string): Promise<boolean> {
    return (await this.load()).get(key) === true;
  }

  /** A switched-off feature looks exactly like a route that does not exist. */
  async assertOn(key: string): Promise<void> {
    if (!(await this.isOn(key))) {
      throw new NotFoundException({ statusCode: 404, code: 'FEATURE_DISABLED', message: 'This feature is not available' });
    }
  }

  /** Control Center edits call this so a change shows up at once. */
  clear(): void {
    this.cache = null;
  }
}
