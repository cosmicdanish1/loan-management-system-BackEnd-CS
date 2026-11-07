import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MOBILE_DS, MOBILE_OFFICE_TZ } from '../mobile.constants';
import { officeStateAt, parseOfficeDays } from './office-hours';

export interface MobileStatus {
  serverTime: string;
  timeZone: string;
  office: { open: string; close: string; days: number[]; isOpenNow: boolean; localTime: string };
  maintenance: { enabled: boolean; message: string };
  app: Record<string, { latestVersion: string | null; minSupportedVersion: string | null; storeUrl: string | null; message: string | null }>;
}

export interface MobileConfig {
  flags: Record<string, boolean>;
  documents: { terms: number | null; privacy: number | null };
  contacts: unknown;
  language: string;
}

/** Public read-only endpoints data for the app start-up: GET /mobile/status and GET /mobile/config (ES-228, ES-229). */
@Injectable()
export class MobileStatusService {
  constructor(@InjectDataSource(MOBILE_DS) private readonly ds: DataSource) {}

  async getStatus(now: Date = new Date()): Promise<MobileStatus> {
    const settingRows: Array<{ key: string; value: string }> = await this.ds.query(`SELECT key, value FROM mobile_setting`);
    const s = Object.fromEntries(settingRows.map((r) => [r.key, r.value]));
    const open = s.office_open || '10:00';
    const close = s.office_close || '18:00';
    const days = parseOfficeDays(s.office_days || '');
    const state = officeStateAt(now, open, close, days);

    const versionRows: Array<{ platform: string; latest_version: string | null; min_supported_version: string | null; store_url: string | null; message: string | null }> =
      await this.ds.query(`SELECT platform, latest_version, min_supported_version, store_url, message FROM mobile_app_version`);

    return {
      serverTime: now.toISOString(),
      timeZone: MOBILE_OFFICE_TZ,
      office: { open, close, days: days.length ? days : [1, 2, 3, 4, 5, 6], isOpenNow: state.isOpen, localTime: state.localTime },
      maintenance: { enabled: String(s.maintenance_enabled).toLowerCase() === 'true', message: s.maintenance_message || '' },
      app: Object.fromEntries(
        versionRows.map((r) => [
          r.platform,
          { latestVersion: r.latest_version, minSupportedVersion: r.min_supported_version, storeUrl: r.store_url, message: r.message },
        ]),
      ),
    };
  }

  async getConfig(language = 'en'): Promise<MobileConfig> {
    const lang = /^[a-z]{2,3}$/i.test(language) ? language.toLowerCase() : 'en';

    const flagRows: Array<{ key: string; enabled: boolean }> = await this.ds.query(`SELECT key, enabled FROM mobile_feature_flag`);

    // Latest PUBLISHED version of each document in the member's language, falling back to English.
    const docRows: Array<{ key: string; language: string; version: number; body: string }> = await this.ds.query(
      `SELECT DISTINCT ON (key) key, language, version, body
         FROM mobile_content
        WHERE published = true AND language IN ($1, 'en')
        ORDER BY key, (language = $1) DESC, version DESC`,
      [lang],
    );
    const doc = (k: string) => docRows.find((r) => r.key === k);
    let contacts: unknown = null;
    const c = doc('contacts');
    if (c) {
      try {
        contacts = JSON.parse(c.body);
      } catch {
        contacts = c.body;
      }
    }

    return {
      flags: Object.fromEntries(flagRows.map((r) => [r.key, !!r.enabled])),
      documents: { terms: doc('terms')?.version ?? null, privacy: doc('privacy')?.version ?? null },
      contacts,
      language: lang,
    };
  }
}
