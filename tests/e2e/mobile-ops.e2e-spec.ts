/**
 * Mobile Control Center: Features and releases (ES-241) and Security and audit (ES-243), against the DEV database, in-process.
 * It changes real switches for a moment and puts every value back in afterAll; blocks it creates are lifted again.
 *   npx jest --config tests/e2e/jest-e2e.json --rootDir . tests/e2e/mobile-ops --forceExit
 */
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import * as path from 'path';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { LoggingModule } from '../../src/common/logging/logging.module';
import { AlertsModule } from '../../src/modules/alerts/alerts.module';
import { ReportHeadOrderModule } from '../../src/modules/report-head-order/report-head-order.module';
import { SharedModule } from '../../src/modules/shared/shared.module';
import { MobileModule } from '../../src/modules/mobile/mobile.module';
import { MOBILE_DS } from '../../src/modules/mobile/mobile.constants';
import { sha256 } from '../../src/modules/mobile/access/mobile-crypto';
import { MobileOpsService } from '../../src/modules/mobile/admin/mobile-ops.service';
import { BlocklistService } from '../../src/modules/mobile/security/blocklist.service';

describe('Mobile ops: features, versions, maintenance, audit, blocklist (e2e, dev DB)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ops: MobileOpsService;
  let blocks: BlocklistService;
  const saved: { flags: any[]; versions: any[]; settings: any[] } = { flags: [], versions: [], settings: [] };
  const created: number[] = [];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: path.join(__dirname, '..', '..', '.env') }),
        LoggingModule, SharedModule, ReportHeadOrderModule, AlertsModule, MobileModule,
        TypeOrmModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (c: ConfigService) => ({
            type: 'postgres' as const, host: c.get<string>('DB_HOST', 'localhost'), port: Number(c.get('DB_PORT', 5432)),
            username: c.get<string>('DB_USERNAME'), password: c.get<string>('DB_PASSWORD'), database: c.get<string>('DB_DATABASE'),
            entities: [path.join(__dirname, '..', '..', 'src').split(path.sep).join('/') + '/**/*.entity.ts'], synchronize: false,
          }),
        }),
      ],
    }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    ds = app.get<DataSource>(getDataSourceToken(MOBILE_DS as any));
    ops = app.get(MobileOpsService);
    blocks = app.get(BlocklistService);
    saved.flags = await ds.query(`SELECT * FROM mobile_feature_flag`);
    saved.versions = await ds.query(`SELECT * FROM mobile_app_version`);
    saved.settings = await ds.query(`SELECT * FROM mobile_setting WHERE key IN ('maintenance_enabled','maintenance_message')`);
  }, 90000);

  afterAll(async () => {
    for (const f of saved.flags) await ds.query(`UPDATE mobile_feature_flag SET enabled = $2, updated_by = $3, updated_at = $4 WHERE key = $1`, [f.key, f.enabled, f.updated_by, f.updated_at]);
    for (const v of saved.versions) await ds.query(`UPDATE mobile_app_version SET latest_version=$2, min_supported_version=$3, store_url=$4, message=$5, updated_by=$6, updated_at=$7 WHERE platform=$1`, [v.platform, v.latest_version, v.min_supported_version, v.store_url, v.message, v.updated_by, v.updated_at]);
    for (const s of saved.settings) await ds.query(`UPDATE mobile_setting SET value=$2, updated_by=$3, updated_at=$4 WHERE key=$1`, [s.key, s.value, s.updated_by, s.updated_at]);
    if (created.length) await ds.query(`DELETE FROM mobile_blocklist WHERE id = ANY($1::bigint[])`, [created]);
    await ds.query(`DELETE FROM mobile_audit_log WHERE event IN ('STAFF_FEATURE_FLAG','STAFF_APP_VERSION','STAFF_MAINTENANCE','STAFF_AUDIT_EXPORT','STAFF_BLOCK_IP','STAFF_UNBLOCK_IP','STAFF_BLOCK_DEVICE','STAFF_UNBLOCK_DEVICE') AND detail->>'by' = 'qa-staff'`);
    for (const name of ['mobile', undefined]) {
      try { await app.get<DataSource>(getDataSourceToken(name as any)).destroy(); } catch { /* already closed */ }
    }
    try { await app.close(); } catch { /* shutdown hook */ }
  });

  it('a feature switch changes /mobile/config at once and only existing switches can be changed', async () => {
    const before = (await ops.features()).flags.find((f) => f.key === 'notices')!.enabled;
    await ops.setFlag('notices', !before, 'qa-staff');
    const cfg = await request(app.getHttpServer()).get('/api/v1/mobile/config').expect(200);
    const flags = (cfg.body.data ?? cfg.body).flags;
    expect(flags.notices).toBe(!before);
    await ops.setFlag('notices', before, 'qa-staff');
    await expect(ops.setFlag('no_such_switch', true, 'qa-staff')).rejects.toThrow(/no such feature/);
    const n = await ds.query(`SELECT count(*)::int AS n FROM mobile_feature_flag WHERE key = 'no_such_switch'`);
    expect(n[0].n).toBe(0);
  });

  it('versions: checked, compared as numbers, and shown by /mobile/status', async () => {
    await expect(ops.setVersion('windows', { latestVersion: '1.0.0', minSupportedVersion: '1.0.0' }, 'qa-staff')).rejects.toThrow(/android or ios/);
    await expect(ops.setVersion('android', { latestVersion: '1.x', minSupportedVersion: '1.0.0' }, 'qa-staff')).rejects.toThrow(/look like/);
    await expect(ops.setVersion('android', { latestVersion: '1.9.0', minSupportedVersion: '1.10.0' }, 'qa-staff')).rejects.toThrow(/cannot be newer/);
    await expect(ops.setVersion('android', { latestVersion: '2.0.0', minSupportedVersion: '1.0.0', storeUrl: 'javascript:alert(1)' }, 'qa-staff')).rejects.toThrow(/https/);
    await ops.setVersion('android', { latestVersion: '1.10.0', minSupportedVersion: '1.9.0', storeUrl: 'https://example.org/app' }, 'qa-staff');
    const st = await request(app.getHttpServer()).get('/api/v1/mobile/status').expect(200);
    expect((st.body.data ?? st.body).app.android).toMatchObject({ latestVersion: '1.10.0', minSupportedVersion: '1.9.0' });
  });

  it('maintenance mode shows in /mobile/status with its message', async () => {
    await ops.setMaintenance(true, 'Back at 3 pm', 'qa-staff');
    const st = await request(app.getHttpServer()).get('/api/v1/mobile/status').expect(200);
    expect((st.body.data ?? st.body).maintenance).toEqual({ enabled: true, message: 'Back at 3 pm' });
    await ops.setMaintenance(false, '', 'qa-staff');
    expect(((await request(app.getHttpServer()).get('/api/v1/mobile/status').expect(200)).body.data ?? {}).maintenance?.enabled ?? false).toBe(false);
  });

  it('audit search filters by event, member and dates; CSV export is safe and itself audited', async () => {
    const rows = await ops.auditSearch({ event: 'STAFF_MAINTENANCE', limit: 5 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ event: 'STAFF_MAINTENANCE', result: 'OK' });
    expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(['at', 'deviceRef', 'ip', 'detail']));
    const today = new Date().toISOString().slice(0, 10);
    expect((await ops.auditSearch({ event: 'STAFF_MAINTENANCE', from: today, to: today, limit: 5 })).length).toBeGreaterThan(0);
    expect(await ops.auditSearch({ mbno: '1', event: 'STAFF_MAINTENANCE' })).toEqual([]);
    await expect(ops.auditSearch({ mbno: "1' OR '1'='1" })).rejects.toThrow(/Invalid member/);
    await expect(ops.auditSearch({ from: 'yesterday' })).rejects.toThrow(/YYYY-MM-DD/);
    const csv = await ops.auditCsv({ event: 'STAFF_MAINTENANCE' }, 'qa-staff');
    expect(csv.split('\r\n')[0]).toBe('time,member,event,result,endpoint,status,device,ip,app version,platform,detail');
    expect((await ops.auditSearch({ event: 'STAFF_AUDIT_EXPORT', limit: 1 })).length).toBe(1);
  });

  it('monitors give 24-hour counts and top lists', async () => {
    const m = await ops.monitors();
    expect(Object.keys(m.last24h)).toEqual(['loginFailed', 'loginOk', 'appCodeFailed', 'activationFailed', 'lockouts', 'tokenReuse']);
    expect(Array.isArray(m.topFailingIps)).toBe(true);
    expect(typeof m.lockedAccounts).toBe('number');
  });

  it('blocking an IP or a phone refuses that caller on every /mobile route, and lifting it brings access back', async () => {
    const http = () => request(app.getHttpServer());
    await http().get('/api/v1/mobile/status').expect(200);

    const ip = await blocks.block('IP', '::ffff:127.0.0.1', 'qa test', 'qa-staff'); created.push(ip.id);
    const refused = await http().get('/api/v1/mobile/status').expect(403);
    expect(refused.body.code).toBe('ACCESS_BLOCKED');
    await expect(blocks.block('IP', '127.0.0.1', 'again', 'qa-staff')).rejects.toThrow(/Already blocked/);
    await blocks.unblock(ip.id, 'qa-staff');
    await http().get('/api/v1/mobile/status').expect(200);
    await expect(blocks.unblock(ip.id, 'qa-staff')).rejects.toThrow(/already lifted/);

    const device = 'qa-blocked-device-0001';
    const dev = await blocks.block('DEVICE', sha256(device), 'qa test', 'qa-staff'); created.push(dev.id);
    await http().get('/api/v1/mobile/status').set('X-Device-Id', device).expect(403);
    await http().get('/api/v1/mobile/status').set('X-Device-Id', 'some-other-phone-0002').expect(200);
    await http().get('/api/v1/mobile/status').expect(200);
    await blocks.unblock(dev.id, 'qa-staff');
    await http().get('/api/v1/mobile/status').set('X-Device-Id', device).expect(200);

    await expect(blocks.block('IP', 'not-an-ip', 'x1x', 'qa-staff')).rejects.toThrow(/valid IP/);
    await expect(blocks.block('DEVICE', 'raw-device-id', 'x1x', 'qa-staff')).rejects.toThrow(/64 characters/);
    expect((await blocks.list()).filter((b) => created.includes(b.id))).toEqual([]);
  });
});
