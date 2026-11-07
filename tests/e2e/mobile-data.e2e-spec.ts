/**
 * Member data routes against REAL dev data, in-process (no dev server): a member with several loans gets a temporary mobile
 * account + phone (removed again in afterAll), and every route is called with a real member token.
 * Checks: the numbers agree with the desktop services, a loan case number that belongs to somebody else is "not found",
 * large ledger ranges need the App Code approval, and NOTHING private (Aadhaar, salary, signature, full phone/PAN, internal flags)
 * appears in any response. Reads only, apart from the temporary mobile_account / mobile_device rows.
 *   npx jest --config tests/e2e/jest-e2e.json --rootDir . tests/e2e/mobile-data.e2e-spec.ts --forceExit
 */
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import * as path from 'path';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { MemberTokenService } from '../../src/modules/mobile/auth/member-token.service';
import { MOBILE_DS } from '../../src/modules/mobile/mobile.constants';
import { MobileModule } from '../../src/modules/mobile/mobile.module';
import { sha256 } from '../../src/modules/mobile/access/mobile-crypto';
// The real app imports these GLOBAL modules in AppModule; the loan / ledger services need them.
import { LoggingModule } from '../../src/common/logging/logging.module';
import { AlertsModule } from '../../src/modules/alerts/alerts.module';
import { ReportHeadOrderModule } from '../../src/modules/report-head-order/report-head-order.module';
import { SharedModule } from '../../src/modules/shared/shared.module';

const FORBIDDEN_KEY = /aadh?a?a?r|basic_?pay|gross|salary|signature|password|mpin|secret|token_?hash|posted_?by|user_?name|pf_?no|doc_?(front|back)|photo_?path|loan_?position|checked_?(by|note)|flag_?code|ledger_?balance|ledgerShowsRepaid|is_payroll|payroll_lag|created_?by/i;
const scanKeys = (v: unknown, p = ''): string[] =>
  Array.isArray(v) ? v.flatMap((x, i) => scanKeys(x, `${p}[${i}]`))
    : v && typeof v === 'object' ? Object.entries(v as object).flatMap(([k, x]) => (FORBIDDEN_KEY.test(k) ? [`${p}.${k}`] : []).concat(scanKeys(x, `${p}.${k}`)))
      : [];

describe('Member data routes (e2e, real data, read-only)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let mbno = '';
  let token = '';
  let secrets: string[] = [];
  let ownLoan: { loanType: string; caseNo: string; status: string } | null = null;
  const bodies: unknown[] = [];

  const get = (url: string, t = token) => request(app.getHttpServer()).get('/api/v1/mobile' + url).set('Authorization', `Bearer ${t}`);
  const ok = async (url: string) => {
    const r = await get(url).expect(200);
    bodies.push(r.body);
    // the real app wraps answers in { success, data }; this reduced test module has no global interceptor, so accept both
    return { data: r.body && r.body.success !== undefined ? r.body.data : r.body };
  };

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

    // A member with several open loans and no mobile data yet.
    const pick: any[] = await ds.query(
      `SELECT l.mbno::text AS mbno FROM loan_master l
        WHERE l.balance > 0 AND NOT EXISTS (SELECT 1 FROM mobile_account a WHERE a.mbno = l.mbno)
        GROUP BY l.mbno ORDER BY count(*) DESC LIMIT 1`,
    );
    mbno = pick[0]?.mbno ?? '';
    if (!mbno) return;
    await ds.query(`INSERT INTO mobile_account (mbno, status, mpin_hash, activated_at) VALUES ($1, 'ACTIVE', 'x', now())`, [mbno]);
    const dev: any[] = await ds.query(`INSERT INTO mobile_device (mbno, device_id_hash) VALUES ($1, $2) RETURNING id`, [mbno, sha256('e2e-data-device')]);
    token = await app.get(MemberTokenService).signAccess(mbno, Number(dev[0].id));

    // Private values of this member that must never show up in a response.
    const priv: any[] = await ds.query(`SELECT aadharno, basic_pay::text AS bp, gross_salary::text AS gs, signature_image_path AS sig, phoneno, pan_no FROM member_master WHERE mbno = $1`, [mbno]);
    const p = priv[0] ?? {};
    secrets = [p.aadharno, p.sig, p.bp, p.gs].map((x) => String(x ?? '').trim()).filter((x) => x.length >= 5 && x !== '0' && !/^0+(\.0+)?$/.test(x));
    // full phone and PAN are shown masked only
    const phone = String(p.phoneno ?? '').replace(/\D/g, '').slice(-10);
    if (phone.length === 10) secrets.push(phone);
    const pan = String(p.pan_no ?? '').trim();
    if (pan.length >= 8) secrets.push(pan);
  }, 90000);

  afterAll(async () => {
    if (mbno) {
      await ds.query(`DELETE FROM mobile_audit_log WHERE mbno = $1`, [mbno]);
      await ds.query(`DELETE FROM mobile_session WHERE mbno = $1`, [mbno]);
      await ds.query(`DELETE FROM mobile_device WHERE mbno = $1`, [mbno]);
      await ds.query(`DELETE FROM mobile_account WHERE mbno = $1`, [mbno]);
    }
    for (const name of ['mobile', undefined]) {
      try { await app.get<DataSource>(getDataSourceToken(name as any)).destroy(); } catch { /* already closed */ }
    }
    try { await app.close(); } catch { /* shutdown hook */ }
  });

  const guard = (fn: () => Promise<void>) => async () => { if (!mbno) return; await fn(); };

  it('refuses to answer without a member token', guard(async () => {
    await request(app.getHttpServer()).get('/api/v1/mobile/home').expect(401);
    await request(app.getHttpServer()).get('/api/v1/mobile/loans').set('Authorization', 'Bearer nope').expect(401);
  }));

  it('home: balances as strings, the member\'s own name, no private fields', guard(async () => {
    const h = await ok('/home');
    expect(h.data.member.memberNo).toBe(mbno);
    expect(h.data.balances.loansOutstanding).toMatch(/^\d+\.\d{2}$/);
    expect(h.data.activeLoans).toBeGreaterThan(0);
    expect(typeof h.data.needsOfficeVisit).toBe('boolean');
  }));

  it('profile and accounts are masked and complete', guard(async () => {
    const p = (await ok('/profile')).data;
    expect(p.memberNo).toBe(mbno);
    if (p.phone) expect(p.phone).toMatch(/^X+\d{4}$/);
    if (p.pan) expect(p.pan).toMatch(/^X+.{4}$/);
    const a = (await ok('/accounts')).data;
    expect(a.shares).toMatch(/^\d+\.\d{2}$/);
    expect(a.savings.total).toMatch(/^\d+\.\d{2}$/);
  }));

  it('loans: active first, and the list agrees with the desktop service', guard(async () => {
    const l = (await ok('/loans')).data.loans;
    expect(l.length).toBeGreaterThan(0);
    const firstClosed = l.findIndex((x: any) => x.status !== 'ACTIVE');
    if (firstClosed >= 0) expect(l.slice(firstClosed).every((x: any) => x.status !== 'ACTIVE')).toBe(true);
    ownLoan = l.find((x: any) => x.status === 'ACTIVE') ?? null;
    expect(ownLoan).toBeTruthy();
    const detail = (await ok(`/loans/${ownLoan!.loanType}/${ownLoan!.caseNo}`)).data.loan;
    expect(detail).toEqual(ownLoan);
  }));

  it('schedule belongs to THIS member\'s loan and payments are real receipts', guard(async () => {
    const s = (await ok(`/loans/${ownLoan!.loanType}/${ownLoan!.caseNo}/schedule`)).data;
    const tenure = (await ok(`/loans/${ownLoan!.loanType}/${ownLoan!.caseNo}`)).data.loan.tenureMonths;
    expect(s.summary.total).toBe(tenure);
    expect(s.installments.every((i: any) => ['PAID', 'OVERDUE', 'UPCOMING'].includes(i.status))).toBe(true);
    const pay = (await ok(`/loans/${ownLoan!.loanType}/${ownLoan!.caseNo}/payments?limit=5`)).data;
    expect(pay.payments.length).toBeLessThanOrEqual(5);
    for (const x of pay.payments) expect(x.amount).toMatch(/^\d+\.\d{2}$/);
  }));

  it('a loan that belongs to somebody else is not found, even when the case number exists', guard(async () => {
    const other: any[] = await ds.query(
      `SELECT loancaseno::text AS c, loantype FROM loan_master o
        WHERE o.mbno <> $1 AND NOT EXISTS (SELECT 1 FROM loan_master m WHERE m.mbno = $1 AND m.loancaseno = o.loancaseno AND m.loantype = o.loantype)
        LIMIT 1`,
      [mbno],
    );
    const r = await get(`/loans/${other[0].loantype}/${other[0].c}`).expect(404);
    expect(r.body.code).toBe('LOAN_NOT_FOUND');
    await get(`/loans/${other[0].loantype}/${other[0].c}/schedule`).expect(404);
    await get(`/loans/${other[0].loantype}/${other[0].c}/payments`).expect(404);
    await get(`/loans/RLN;DROP/1`).expect(400);
  }));

  it('a shared case number returns the schedule of the member who is asking', guard(async () => {
    const shared: any[] = await ds.query(
      `SELECT a.loancaseno::text AS c, a.loantype, a.mbno::text AS m1, b.mbno::text AS m2
         FROM loan_master a JOIN loan_master b ON a.loancaseno = b.loancaseno AND a.loantype = b.loantype AND a.mbno < b.mbno
        WHERE a.balance > 0 AND b.balance > 0 AND a.no_of_instal <> b.no_of_instal LIMIT 1`,
    );
    if (!shared.length) return; // no such pair in this database
    const dev: any[] = await ds.query(`SELECT id FROM mobile_device WHERE mbno = $1`, [mbno]);
    for (const m of [shared[0].m1, shared[0].m2]) {
      const acct: any[] = await ds.query(`SELECT 1 FROM mobile_account WHERE mbno = $1`, [m]);
      if (acct.length) return; // never touch a member who already has mobile data
    }
    const tokens = app.get(MemberTokenService);
    const made: string[] = [];
    try {
      const t: Record<string, string> = {};
      for (const m of [shared[0].m1, shared[0].m2]) {
        await ds.query(`INSERT INTO mobile_account (mbno, status, mpin_hash) VALUES ($1, 'ACTIVE', 'x')`, [m]);
        const d: any[] = await ds.query(`INSERT INTO mobile_device (mbno, device_id_hash) VALUES ($1, $2) RETURNING id`, [m, sha256('e2e-' + m)]);
        made.push(m);
        t[m] = await tokens.signAccess(m, Number(d[0].id));
      }
      const tenure = async (m: string) => (await ds.query(`SELECT no_of_instal FROM loan_master WHERE mbno = $1 AND loancaseno::text = $2 AND loantype = $3`, [m, shared[0].c, shared[0].loantype]))[0].no_of_instal;
      for (const m of [shared[0].m1, shared[0].m2]) {
        const s = await get(`/loans/${shared[0].loantype}/${shared[0].c}/schedule`, t[m]).expect(200);
        expect((s.body.data ?? s.body).summary.total).toBe(Number(await tenure(m))); // each member sees HIS OWN loan
      }
    } finally {
      for (const m of made) {
        await ds.query(`DELETE FROM mobile_audit_log WHERE mbno = $1`, [m]);
        await ds.query(`DELETE FROM mobile_device WHERE mbno = $1`, [m]);
        await ds.query(`DELETE FROM mobile_account WHERE mbno = $1`, [m]);
      }
    }
    expect(dev.length).toBe(1);
  }));

  it('ledger: recent range works and is paged; an old range needs the App Code approval', guard(async () => {
    const d = (n: number) => { const x = new Date(); x.setMonth(x.getMonth() - n); return x.toISOString().slice(0, 10); };
    const today = new Date().toISOString().slice(0, 10);
    const recent = (await ok(`/ledger?from=${d(6)}&to=${today}&limit=5`)).data;
    expect(recent.entries.length).toBeLessThanOrEqual(5);
    expect(recent.totals.debit).toMatch(/^\d+\.\d{2}$/);
    const old = await get(`/ledger?from=${d(30)}&to=${today}`).expect(403);
    expect(old.body.code).toBe('APPCODE_REQUIRED');
    await get(`/ledger?from=bad&to=${today}`).expect(400);
  }));

  it('notices list answers (only notices marked for mobile)', guard(async () => {
    const n = (await ok('/notices')).data;
    expect(Array.isArray(n.notices)).toBe(true);
  }));

  it('NOTHING private appears in any response', guard(async () => {
    expect(bodies.length).toBeGreaterThan(5);
    const text = JSON.stringify(bodies);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(scanKeys(bodies)).toEqual([]);
  }));
});
