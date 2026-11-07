import { MobileStatusService } from '../../../src/modules/mobile/status/mobile-status.service';

function service(handlers: Record<string, unknown[]>) {
  const ds = {
    query: jest.fn(async (sql: string) => {
      const key = Object.keys(handlers).find((k) => sql.includes(k));
      if (!key) throw new Error('unexpected sql: ' + sql);
      return handlers[key];
    }),
  };
  return { svc: new MobileStatusService(ds as any), ds };
}

describe('MobileStatusService.getStatus', () => {
  const settings = [
    { key: 'office_open', value: '10:00' },
    { key: 'office_close', value: '18:00' },
    { key: 'office_days', value: '1,2,3,4,5,6' },
    { key: 'maintenance_enabled', value: 'false' },
    { key: 'maintenance_message', value: '' },
  ];
  const versions = [
    { platform: 'android', latest_version: '1.2.0', min_supported_version: '1.0.0', store_url: null, message: null },
    { platform: 'ios', latest_version: '1.2.0', min_supported_version: '1.1.0', store_url: 'https://apps.apple.com/x', message: 'Update please' },
  ];

  it('reports office state in IST, versions per platform and no maintenance', async () => {
    const { svc } = service({ mobile_setting: settings, mobile_app_version: versions });
    const s = await svc.getStatus(new Date('2026-10-14T06:30:00Z')); // Wed 12:00 IST
    expect(s.serverTime).toBe('2026-10-14T06:30:00.000Z');
    expect(s.timeZone).toBe('Asia/Kolkata');
    expect(s.office).toEqual({ open: '10:00', close: '18:00', days: [1, 2, 3, 4, 5, 6], isOpenNow: true, localTime: '12:00' });
    expect(s.maintenance).toEqual({ enabled: false, message: '' });
    expect(s.app.ios).toEqual({ latestVersion: '1.2.0', minSupportedVersion: '1.1.0', storeUrl: 'https://apps.apple.com/x', message: 'Update please' });
    expect(s.app.android.minSupportedVersion).toBe('1.0.0');
  });

  it('shows the maintenance switch and a closed office', async () => {
    const { svc } = service({
      mobile_setting: settings.map((r) => (r.key === 'maintenance_enabled' ? { ...r, value: 'TRUE' } : r.key === 'maintenance_message' ? { ...r, value: 'Back at 3 pm' } : r)),
      mobile_app_version: [],
    });
    const s = await svc.getStatus(new Date('2026-10-14T20:00:00Z')); // Thu 01:30 IST
    expect(s.maintenance).toEqual({ enabled: true, message: 'Back at 3 pm' });
    expect(s.office.isOpenNow).toBe(false);
    expect(s.app).toEqual({});
  });

  it('still answers with defaults when no settings exist yet', async () => {
    const { svc } = service({ mobile_setting: [], mobile_app_version: [] });
    const s = await svc.getStatus(new Date('2026-10-14T06:30:00Z'));
    expect(s.office).toMatchObject({ open: '10:00', close: '18:00', isOpenNow: true });
  });
});

describe('MobileStatusService.getConfig', () => {
  const flags = [
    { key: 'loans', enabled: true },
    { key: 'fd', enabled: false },
  ];

  it('returns flags, published document versions and contacts', async () => {
    const { svc, ds } = service({
      mobile_feature_flag: flags,
      mobile_content: [
        { key: 'terms', language: 'hi', version: 3, body: 'x' },
        { key: 'privacy', language: 'en', version: 2, body: 'y' },
        { key: 'contacts', language: 'en', version: 1, body: '{"phone":"0771-000000"}' },
      ],
    });
    const c = await svc.getConfig('hi');
    expect(c.flags).toEqual({ loans: true, fd: false });
    expect(c.documents).toEqual({ terms: 3, privacy: 2 });
    expect(c.contacts).toEqual({ phone: '0771-000000' });
    expect(c.language).toBe('hi');
    // language is passed as a bound parameter, never concatenated
    expect(ds.query).toHaveBeenCalledWith(expect.stringContaining('mobile_content'), ['hi']);
  });

  it('returns null document versions until something is published, and keeps plain-text contacts', async () => {
    const { svc } = service({ mobile_feature_flag: flags, mobile_content: [{ key: 'contacts', language: 'en', version: 1, body: 'Office: 0771' }] });
    const c = await svc.getConfig('en');
    expect(c.documents).toEqual({ terms: null, privacy: null });
    expect(c.contacts).toBe('Office: 0771');
  });

  it('ignores a suspicious language value', async () => {
    const { svc, ds } = service({ mobile_feature_flag: [], mobile_content: [] });
    const c = await svc.getConfig("en'; DROP TABLE mobile_setting;--");
    expect(c.language).toBe('en');
    expect(ds.query).toHaveBeenCalledWith(expect.stringContaining('mobile_content'), ['en']);
  });
});
