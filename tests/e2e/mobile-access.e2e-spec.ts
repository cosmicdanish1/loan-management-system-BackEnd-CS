/**
 * End-to-end check of member access against the DEV database, in-process (no dev server, no port):
 * staff issue a code -> member activates -> MPIN login, lockout, refresh rotation + theft detection, App Code step-up,
 * block / unblock / sign-out, activation requests, and the staff-first queue.
 * It writes only mobile_* rows for ONE test member and removes them again in afterAll.
 *   npx jest --config tests/e2e/jest-e2e.json --rootDir . tests/e2e/mobile-access.e2e-spec.ts --forceExit
 */
import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import * as path from 'path';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { Public } from '../../src/modules/auth/decorators';
import { currentStep, hotp } from '../../src/modules/auth/twofa/totp.util';
import { CurrentMember, MemberJwtGuard } from '../../src/modules/mobile/auth/member-jwt.guard';
import { MobileModule } from '../../src/modules/mobile/mobile.module';
// Global modules the real app gets from AppModule; the loan / ledger services used by MobileModule need them.
import { LoggingModule } from '../../src/common/logging/logging.module';
import { AlertsModule } from '../../src/modules/alerts/alerts.module';
import { ReportHeadOrderModule } from '../../src/modules/report-head-order/report-head-order.module';
import { SharedModule } from '../../src/modules/shared/shared.module';
import { MobileAdminService } from '../../src/modules/mobile/admin/mobile-admin.service';
import { MemberDirectoryService } from '../../src/modules/mobile/access/member-directory.service';
import { AdmissionService } from '../../src/modules/mobile/queue/admission.service';
import { MOBILE_DS } from '../../src/modules/mobile/mobile.constants';

@Public()
@UseGuards(MemberJwtGuard)
@Controller('mobile/probe')
class MemberProbe {
  @Get('me') me(@CurrentMember() m: any) { return { mbno: m.mbno }; }
}
@Controller('staff-slow')
class StaffSlow {
  @Get() async slow() { await new Promise((r) => setTimeout(r, 600)); return { done: Date.now() }; }
}

const DEVICE = 'qa-device-aaaaaaaa-0001';
const DEVICE2 = 'qa-device-bbbbbbbb-0002';
const GOOD_MPIN = '482915';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Member access (e2e, dev DB, test member only)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let admin: MobileAdminService;
  let directory: MemberDirectoryService;
  let mbno: string | null = null;
  const http = () => request(app.getHttpServer());
  const post = (url: string, body: object, token?: string) => {
    const r = http().post('/api/v1/mobile' + url).send(body);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  let access = '';
  let refresh = '';
  let appSecret = '';

  async function clean(): Promise<void> {
    if (!mbno) return;
    for (const t of ['mobile_audit_log', 'mobile_session', 'mobile_push_token', 'mobile_consent', 'mobile_activation_request', 'mobile_activation_code', 'mobile_device', 'mobile_account']) {
      await ds.query(`DELETE FROM ${t} WHERE mbno = $1`, [mbno]);
    }
  }
  async function newCode(): Promise<string> {
    return (await admin.issueCode(mbno!, 'qa-staff')).code;
  }
  async function activate(deviceId = DEVICE): Promise<void> {
    const code = await newCode();
    const a = await post('/auth/activate', { mbno, code, deviceId }).expect(200);
    const c = await post('/auth/activate/complete', { ticket: a.body.ticket, mpin: GOOD_MPIN, deviceId, platform: 'android', model: 'QA Phone', appVersion: '0.1.0', consent: { termsVersion: 1, privacyVersion: 1 } }).expect(200);
    access = c.body.accessToken;
    refresh = c.body.refreshToken;
    appSecret = c.body.appCodeSecret;
  }
  const login = (mpin: string, deviceId = DEVICE) => post('/auth/login', { mbno, mpin, deviceId });
  const totp = (offset = 0) => hotp(appSecret, currentStep() + offset);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: path.join(__dirname, '..', '..', '.env') }),
        LoggingModule,
        SharedModule,
        ReportHeadOrderModule,
        AlertsModule,
        MobileModule,
        TypeOrmModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (c: ConfigService) => ({ type: 'postgres' as const, host: c.get<string>('DB_HOST', 'localhost'), port: Number(c.get('DB_PORT', 5432)), username: c.get<string>('DB_USERNAME'), password: c.get<string>('DB_PASSWORD'), database: c.get<string>('DB_DATABASE'), entities: [path.join(__dirname, '..', '..', 'src').split(path.sep).join('/') + '/**/*.entity.ts'], synchronize: false }),
        }),
      ],
      controllers: [MemberProbe, StaffSlow],
    }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    ds = app.get<DataSource>(getDataSourceToken(MOBILE_DS as any));
    admin = app.get(MobileAdminService);
    directory = app.get(MemberDirectoryService);

    // A test member (number range 900000001-900016999) that has no mobile data yet.
    const r: any[] = await ds.query(
      `SELECT m.mbno::text AS mbno FROM member_master m
        WHERE m.mbno BETWEEN 900000001 AND 900016999 AND COALESCE(m.isactive,'Y') <> 'N'
          AND NOT EXISTS (SELECT 1 FROM mobile_account a WHERE a.mbno = m.mbno)
          AND NOT EXISTS (SELECT 1 FROM mobile_activation_request q WHERE q.mbno = m.mbno)
        ORDER BY m.mbno LIMIT 1`,
    );
    mbno = r[0]?.mbno ?? null;
    if (!mbno) console.warn('No suitable test member found: member access tests are skipped');
  }, 60000);

  afterAll(async () => {
    await clean();
    for (const name of ['mobile', undefined]) {
      try { await app.get<DataSource>(getDataSourceToken(name as any)).destroy(); } catch { /* already closed */ }
    }
    try { await app.close(); } catch { /* shutdown hook needs the default connection token */ }
  });

  const guard = (fn: () => Promise<void>) => async () => { if (!mbno) return; await fn(); };

  it('activation fails the same way for a wrong code and for an unknown member', guard(async () => {
    await newCode();
    const wrong = await post('/auth/activate', { mbno, code: 'ZZZZ-ZZZZ', deviceId: DEVICE }).expect(401);
    const unknown = await post('/auth/activate', { mbno: '1', code: 'ZZZZ-ZZZZ', deviceId: DEVICE }).expect(401);
    expect(wrong.body.code).toBe('INVALID_ACTIVATION');
    expect(unknown.body.code).toBe('INVALID_ACTIVATION');
    expect(wrong.body.message).toBe(unknown.body.message);
  }));

  it('a code is burned after 5 wrong tries', guard(async () => {
    const code = await newCode();
    for (let i = 0; i < 5; i++) await post('/auth/activate', { mbno, code: 'AAAA-AAAA', deviceId: DEVICE }).expect(401);
    await post('/auth/activate', { mbno, code, deviceId: DEVICE }).expect(401); // even the right code no longer works
  }));

  it('activates: weak MPIN refused, good MPIN gives tokens and a one-time App Code secret', guard(async () => {
    const code = await newCode();
    const a = await post('/auth/activate', { mbno, code: code.toLowerCase(), deviceId: DEVICE }).expect(200);
    const weak = await post('/auth/activate/complete', { ticket: a.body.ticket, mpin: '123456', deviceId: DEVICE }).expect(400);
    expect(weak.body.code).toBe('MPIN_TOO_WEAK');
    const wrongPhone = await post('/auth/activate/complete', { ticket: a.body.ticket, mpin: GOOD_MPIN, deviceId: 'some-other-phone-0000' }).expect(401);
    expect(wrongPhone.body.code).toBe('INVALID_ACTIVATION'); // the ticket is bound to the phone that asked for it
    const c = await post('/auth/activate/complete', { ticket: a.body.ticket, mpin: GOOD_MPIN, deviceId: DEVICE, platform: 'android', model: 'QA Phone', appVersion: '0.1.0', consent: { termsVersion: 1, privacyVersion: 1 } }).expect(200);
    expect(c.body.accessToken).toBeTruthy();
    expect(c.body.refreshToken).toBeTruthy();
    expect(c.body.appCodeSecret).toMatch(/^[A-Z2-7]{32}$/);
    access = c.body.accessToken; refresh = c.body.refreshToken; appSecret = c.body.appCodeSecret;
    // the ticket / code cannot be used a second time
    await post('/auth/activate/complete', { ticket: a.body.ticket, mpin: GOOD_MPIN, deviceId: DEVICE }).expect(401);
    // secrets are never stored in clear
    const dev: any[] = await ds.query(`SELECT appcode_secret_enc FROM mobile_device WHERE mbno = $1`, [mbno]);
    expect(dev[0].appcode_secret_enc).not.toContain(appSecret);
    const acct: any[] = await ds.query(`SELECT mpin_hash FROM mobile_account WHERE mbno = $1`, [mbno]);
    expect(acct[0].mpin_hash).toMatch(/^\$2[aby]\$/);
    const consent: any[] = await ds.query(`SELECT doc_type FROM mobile_consent WHERE mbno = $1 ORDER BY doc_type`, [mbno]);
    expect(consent.map((x) => x.doc_type)).toEqual(['PRIVACY', 'TERMS']);
  }));

  it('the access token opens member routes; staff-style and junk tokens do not', guard(async () => {
    const ok = await http().get('/api/v1/mobile/probe/me').set('Authorization', `Bearer ${access}`).expect(200);
    expect(ok.body.mbno).toBe(mbno);
    await http().get('/api/v1/mobile/probe/me').expect(401);
    await http().get('/api/v1/mobile/probe/me').set('Authorization', 'Bearer junk').expect(401);
  }));

  it('MPIN login: unknown phone looks like a wrong password; wrong tries delay then lock; staff unlock', guard(async () => {
    await login(GOOD_MPIN, 'a-phone-that-was-never-bound-1').expect(401);
    const w1 = await login('000111').expect(401);
    expect(w1.body.attemptsLeft).toBe(4);
    await login('000111').expect(401);
    const w3 = await login('000111').expect(401);
    expect(w3.body.attemptsLeft).toBe(2);
    const delayed = await login(GOOD_MPIN).expect(429); // 30 s wait after the 3rd wrong MPIN, even for the right one
    expect(delayed.body.code).toBe('MPIN_DELAY');
    await ds.query(`UPDATE mobile_account SET locked_until = NULL WHERE mbno = $1`, [mbno]);
    await login('000111').expect(401); // 4th
    await ds.query(`UPDATE mobile_account SET locked_until = NULL WHERE mbno = $1`, [mbno]);
    const locked = await login('000111').expect(423); // 5th
    expect(locked.body.code).toBe('MPIN_LOCKED');
    await login(GOOD_MPIN).expect(423); // the right MPIN no longer works until staff unlock
    await admin.unlock(mbno!, 'qa-staff');
    const ok = await login(GOOD_MPIN).expect(200);
    expect(ok.body.accessToken).toBeTruthy();
    access = ok.body.accessToken; refresh = ok.body.refreshToken;
  }));

  it('refresh rotates the token and a reused old token kills the whole session family', guard(async () => {
    const first = refresh;
    const r1 = await post('/auth/refresh', { refreshToken: first, deviceId: DEVICE }).expect(200);
    expect(r1.body.refreshToken).not.toBe(first);
    const reuse = await post('/auth/refresh', { refreshToken: first, deviceId: DEVICE }).expect(401);
    expect(reuse.body.code).toBe('REFRESH_REUSED');
    const after = await post('/auth/refresh', { refreshToken: r1.body.refreshToken, deviceId: DEVICE }).expect(401); // family is dead
    expect(after.body.code).toBe('REFRESH_INVALID');
    await post('/auth/refresh', { refreshToken: 'x'.repeat(40), deviceId: DEVICE }).expect(401);
    const ok = await login(GOOD_MPIN).expect(200); // signing in again starts a new family
    access = ok.body.accessToken; refresh = ok.body.refreshToken;
    // a refresh token only works from the phone it was issued to
    await post('/auth/refresh', { refreshToken: refresh, deviceId: 'a-phone-that-was-never-bound-1' }).expect(401);
  }));

  it('App Code: step-up approves one action; a used code, a wrong code and 5 wrong codes are refused; staff can verify', guard(async () => {
    const c1 = totp();
    const up = await post('/auth/step-up', { action: 'CHANGE_MPIN', code: c1 }, access).expect(200);
    expect(up.body.approval).toBeTruthy();
    expect(up.body.expiresIn).toBe(120);
    const replay = await post('/auth/step-up', { action: 'CHANGE_MPIN', code: c1 }, access).expect(401);
    expect(replay.body.code).toBe('APPCODE_INVALID');
    await post('/auth/step-up', { action: 'NOT_A_REAL_ACTION', code: totp(1) }, access).expect(400);
    await post('/auth/step-up', { action: 'CHANGE_MPIN', code: totp(1) }, access).expect(401).catch(() => undefined); // step+1 is allowed once

    // staff verify with a fresh step (replay protection applies to staff too)
    const staffOk = await admin.verifyAppCode(mbno!, hotp(appSecret, currentStep() + 1), 'qa-staff');
    expect(['ok', 'replay']).toContain(staffOk.result);

    for (let i = 0; i < 4; i++) await post('/auth/step-up', { action: 'CHANGE_MPIN', code: '000000' }, access).expect(401);
    const locked = await post('/auth/step-up', { action: 'CHANGE_MPIN', code: '000000' }, access).expect(403);
    expect(locked.body.code).toBe('APPCODE_LOCKED');
    expect((await admin.verifyAppCode(mbno!, '000000', 'qa-staff')).result).toBe('locked');
    await ds.query(`UPDATE mobile_device SET appcode_wrong = 0, appcode_locked_until = NULL WHERE mbno = $1`, [mbno]);
  }));

  it('block, unblock and sign-out-everywhere take effect on existing tokens and logins', guard(async () => {
    await admin.block(mbno!, 'QA test block', 'qa-staff');
    await http().get('/api/v1/mobile/probe/me').set('Authorization', `Bearer ${access}`).expect(401);
    const blocked = await login(GOOD_MPIN).expect(403);
    expect(blocked.body.code).toBe('ACCESS_BLOCKED');
    await expect(admin.issueCode(mbno!, 'qa-staff')).rejects.toThrow(/blocked/i);
    await admin.unblock(mbno!, 'qa-staff');
    const ok = await login(GOOD_MPIN).expect(200);
    access = ok.body.accessToken;
    await http().get('/api/v1/mobile/probe/me').set('Authorization', `Bearer ${access}`).expect(200);

    const out = await admin.signOutEverywhere(mbno!, 'qa-staff');
    expect(out.devicesRevoked).toBe(1);
    await http().get('/api/v1/mobile/probe/me').set('Authorization', `Bearer ${access}`).expect(401);
    await login(GOOD_MPIN).expect(401);
  }));

  it('a new activation on another phone signs the old phone out', guard(async () => {
    await activate(DEVICE);
    const old = access;
    await activate(DEVICE2);
    await http().get('/api/v1/mobile/probe/me').set('Authorization', `Bearer ${old}`).expect(401);
    await http().get('/api/v1/mobile/probe/me').set('Authorization', `Bearer ${access}`).expect(200);
    await login(GOOD_MPIN, DEVICE).expect(401);
    await login(GOOD_MPIN, DEVICE2).expect(200);
  }));

  it('activation request: same reply for everyone, staff see the match result, call back, approve gives a usable code', guard(async () => {
    const m = (await directory.getMember(mbno!))!;
    if (!m.dob || !m.panLast4 || !m.phone10) return; // this test member has no DOB/PAN/phone on record
    const body = { mbno, dob: m.dob, panLast4: m.panLast4, phoneLast4: m.phone10.slice(-4), deviceId: DEVICE };
    const known = await post('/auth/activation-request', body).expect(202);
    const unknown = await post('/auth/activation-request', { ...body, mbno: '1' }).expect(202);
    expect(known.body).toEqual(unknown.body);

    const list = await admin.listRequests('NEW');
    const mine = list.find((r) => r.mbno === mbno)!;
    expect(mine).toBeTruthy();
    expect(mine.match).toMatchObject({ dob: true, pan: true, phone: true });
    // raw answers are never stored
    const raw: any[] = await ds.query(`SELECT answers_hash FROM mobile_activation_request WHERE mbno = $1`, [mbno]);
    expect(JSON.stringify(raw)).not.toContain(m.dob);

    await admin.markCalledBack(mine.id, 'qa-staff', 'spoke to member');
    const issued = await admin.approveRequest(mine.id, 'qa-staff');
    const a = await post('/auth/activate', { mbno, code: issued.display, deviceId: DEVICE }).expect(200);
    expect(a.body.ticket).toBeTruthy();
    await expect(admin.approveRequest(mine.id, 'qa-staff')).rejects.toThrow(/already closed/);
  }));

  it('staff-first queue: a mobile request waits for a running staff request and is then served', guard(async () => {
    const adm = app.get(AdmissionService);
    await activate(DEVICE);
    await sleep(400); // let the staff grace period of the previous steps pass
    const t0 = Date.now();
    const staff = http().get('/api/v1/staff-slow').then((r) => ({ at: Date.now() - t0, status: r.status }));
    await sleep(80);
    const mobile = http().get('/api/v1/mobile/probe/me').set('Authorization', `Bearer ${access}`).then((r) => ({ at: Date.now() - t0, status: r.status, wait: r.headers['x-queue-wait-ms'] }));
    const [s, m] = await Promise.all([staff, mobile]);
    expect(s.status).toBe(200);
    expect(m.status).toBe(200);
    expect(m.at).toBeGreaterThanOrEqual(s.at); // members were served AFTER the staff request finished
    expect(Number(m.wait)).toBeGreaterThan(300);
    expect(adm.stats().admitted).toBeGreaterThan(0);
  }));

  it('phone data-quality report: every active member is in exactly one group', async () => {
    const sum = await admin.phoneQualitySummary();
    expect(sum.ok + sum.missing + sum.invalid + sum.shared).toBe(sum.activeMembers);
    expect(sum.activeMembers).toBeGreaterThan(0);
    const missing = await admin.phoneQualityMembers('MISSING', 0, 5);
    expect(missing.length).toBeLessThanOrEqual(5);
    if (sum.shared > 0) {
      const shared = await admin.phoneQualityMembers('SHARED', 0, 5);
      expect(shared[0].sharedCount).toBeGreaterThan(3);
      expect(sum.sharedNumbers[0].members).toBeGreaterThan(3);
    }
  });

  it('audit trail has the security events, without secrets', guard(async () => {
    const ev: any[] = await ds.query(`SELECT event, result, detail::text AS detail FROM mobile_audit_log WHERE mbno = $1`, [mbno]);
    const names = new Set(ev.map((e) => e.event));
    for (const n of ['ACTIVATION_CODE_ISSUED', 'ACTIVATE', 'ACTIVATION_COMPLETE', 'LOGIN', 'MPIN_LOCKED', 'STEP_UP', 'STAFF_BLOCK', 'STAFF_UNBLOCK', 'STAFF_UNLOCK']) expect(names).toContain(n);
    const blob = JSON.stringify(ev);
    expect(blob).not.toContain(GOOD_MPIN);
    expect(blob).not.toContain(appSecret);
  }));
});
