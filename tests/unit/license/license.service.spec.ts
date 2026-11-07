import * as crypto from 'crypto';

const SECRET = 'PWT_LMS_SECRET_KEY_2025_CHANGE_IN_PROD';
process.env.LICENSE_LEGACY_UNTIL = '2999-12-31'; // old-format (PWT0) keys are only accepted during the announced overlap
process.env.LICENSE_SECRET = SECRET; // the service has no built-in secret any more; it comes from .env (ES-393)
const DAY = 86_400_000;

function makeKey(customer: string, expiry: Date, secret = SECRET): string {
  const enc = Math.floor(expiry.getTime() / DAY).toString(36).toUpperCase().padStart(4, '0');
  const sig = crypto.createHmac('sha256', secret).update(`${customer}${enc}`).digest('hex').toUpperCase().slice(0, 8);
  return `PWT0-${customer}-${enc}-${sig.slice(0, 4)}-${sig.slice(4)}`;
}

/** Fresh module per test: the service keeps a day-cache in a module variable. */
function load() {
  let LicenseService: any; let LicenseStatus: any;
  jest.isolateModules(() => {
    LicenseService = require('../../../src/modules/license/license.service').LicenseService;
    LicenseStatus = require('../../../src/modules/license/entities/license-key.entity').LicenseStatus;
  });
  const qb: any = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), execute: jest.fn().mockResolvedValue({}), getOne: jest.fn() };
  const repo: any = {
    createQueryBuilder: jest.fn().mockReturnValue(qb), findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((x) => ({ ...x })), save: jest.fn(async (x) => x), find: jest.fn().mockResolvedValue([]),
  };
  return { svc: new LicenseService(repo), repo, qb, LicenseStatus };
}
const inDays = (n: number) => new Date(Date.now() + n * DAY);

describe('license/activate', () => {
  it('activates a valid key and reports active', async () => {
    const { svc, repo } = load();
    const r = await svc.activate({ key: makeKey('ACME', inDays(100)) });
    expect(r.status).toBe('active'); expect(r.customer_name).toBe('ACME');
    expect(repo.save).toHaveBeenCalled();
  });
  it('is case and whitespace tolerant', async () => {
    const { svc } = load();
    const r = await svc.activate({ key: `  ${makeKey('ACME', inDays(100)).toLowerCase()}  ` });
    expect(r.status).toBe('active');
  });
  it('rejects a key with a wrong signature', async () => {
    const { svc } = load();
    await expect(svc.activate({ key: makeKey('ACME', inDays(100), 'other-secret') })).rejects.toMatchObject({ status: 400 });
  });
  it('rejects a key whose expiry was edited (signature no longer fits)', async () => {
    const { svc } = load();
    const k = makeKey('ACME', inDays(10)).split('-'); k[2] = (parseInt(k[2], 36) + 1000).toString(36).toUpperCase().padStart(4, '0');
    await expect(svc.activate({ key: k.join('-') })).rejects.toThrow(/Invalid license key/);
  });
  it('rejects garbage and wrong prefix', async () => {
    const { svc } = load();
    for (const k of ['', 'abc', 'XXXX-ACME-0000-AAAA-BBBB', 'PWT0-A-B-C']) {
      await expect(svc.activate({ key: k })).rejects.toMatchObject({ status: 400 });
    }
  });
  it('rejects an already expired key', async () => {
    const { svc } = load();
    await expect(svc.activate({ key: makeKey('ACME', inDays(-5)) })).rejects.toThrow(/already expired/);
  });
  it('revokes every earlier active/expired/pending license first', async () => {
    const { svc, qb, LicenseStatus } = load();
    await svc.activate({ key: makeKey('ACME', inDays(100)) });
    expect(qb.set).toHaveBeenCalledWith({ status: LicenseStatus.REVOKED });
  });
  it('re-activating a known key updates the record instead of inserting', async () => {
    const { svc, repo } = load();
    repo.findOne.mockResolvedValue({ key: 'x', status: 'revoked' });
    await svc.activate({ key: makeKey('ACME', inDays(100)), machine_id: 'M1' });
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.save.mock.calls[0][0]).toMatchObject({ status: 'active', machine_id: 'M1' });
  });
  it('sets the grace period to expiry + 30 days', async () => {
    const { svc } = load();
    const exp = inDays(100);
    const r = await svc.activate({ key: makeKey('ACME', exp) });
    const diff = Math.round((r.grace_ends_at.getTime() - r.expires_at.getTime()) / DAY);
    expect(diff).toBe(30);
  });
  it('warns when fewer than 31 days remain', async () => {
    const { svc } = load();
    const r = await svc.activate({ key: makeKey('ACME', inDays(10)) });
    expect(r.message).toMatch(/expires in/);
  });
  it('a key that expires today (UTC midnight, already passed) is rejected', async () => {
    const { svc } = load();
    const today = new Date(Math.floor(Date.now() / DAY) * DAY);
    await expect(svc.activate({ key: makeKey('ACME', today) })).rejects.toMatchObject({ status: 400 });
  });
  it('the signing secret is not the hard-coded default (must come from configuration)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../../src/modules/license/license.service.ts'), 'utf8');
    expect(src).not.toContain('PWT_LMS_SECRET_KEY_2025_CHANGE_IN_PROD');
  });
});

describe('license/activate without a configured secret (ES-393)', () => {
  afterEach(() => { process.env.LICENSE_SECRET = SECRET; });
  it('refuses with 503 and saves nothing when LICENSE_SECRET is not set', async () => {
    delete process.env.LICENSE_SECRET;
    const { svc, repo } = load();
    await expect(svc.activate({ key: makeKey('ACME', inDays(100)) })).rejects.toMatchObject({ status: 503 });
    expect(repo.save).not.toHaveBeenCalled();
  });
  it('a key signed with the old built-in default is NOT accepted when the real secret is different', async () => {
    process.env.LICENSE_SECRET = 'a-different-long-random-secret-value';
    const { svc } = load();
    await expect(svc.activate({ key: makeKey('ACME', inDays(100)) })).rejects.toMatchObject({ status: 400 });
  });
  it('a key signed with the configured secret works', async () => {
    process.env.LICENSE_SECRET = 'a-different-long-random-secret-value';
    const { svc } = load();
    expect((await svc.activate({ key: makeKey('ACME', inDays(100), 'a-different-long-random-secret-value') })).status).toBe('active');
  });
  it('a blank (spaces only) secret counts as not set', async () => {
    process.env.LICENSE_SECRET = '   ';
    const { svc } = load();
    await expect(svc.activate({ key: makeKey('ACME', inDays(100)) })).rejects.toMatchObject({ status: 503 });
  });
  it('the key generator script does not carry a built-in secret either', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../../generate-license.js'), 'utf8');
    expect(src).not.toContain('PWT_LMS_SECRET_KEY_2025_CHANGE_IN_PROD');
  });
});

describe('license/getStatus', () => {
  it('not_activated when no license row exists', async () => {
    const { svc, qb } = load(); qb.getOne.mockResolvedValue(null);
    expect((await svc.getStatus()).status).toBe('not_activated');
  });
  it('active license', async () => {
    const { svc, qb } = load();
    qb.getOne.mockResolvedValue({ status: 'active', expires_at: inDays(60), grace_ends_at: inDays(90), customer_name: 'A', activated_at: new Date() });
    const r = await svc.getStatus();
    expect(r.status).toBe('active'); expect(r.days_remaining).toBeGreaterThan(55);
  });
  it('grace period: status grace, row flagged expired', async () => {
    const { svc, qb, repo } = load();
    qb.getOne.mockResolvedValue({ status: 'active', expires_at: inDays(-5), grace_ends_at: inDays(25), customer_name: 'A', activated_at: new Date() });
    const r = await svc.getStatus();
    expect(r.status).toBe('grace'); expect(r.days_remaining).toBe(0); expect(r.grace_days_remaining).toBeGreaterThan(20);
    expect(repo.save.mock.calls[0][0].status).toBe('expired');
  });
  it('expired after the grace period: software locked', async () => {
    const { svc, qb } = load();
    qb.getOne.mockResolvedValue({ status: 'expired', expires_at: inDays(-60), grace_ends_at: inDays(-30), customer_name: 'A', activated_at: new Date() });
    const r = await svc.getStatus();
    expect(r.status).toBe('expired'); expect(r.grace_days_remaining).toBe(0);
  });
  it('caches the answer for the calendar day', async () => {
    const { svc, qb } = load(); qb.getOne.mockResolvedValue(null);
    await svc.getStatus(); await svc.getStatus();
    expect(qb.getOne).toHaveBeenCalledTimes(1);
  });
  it('listAll returns rows newest first', async () => {
    const { svc, repo } = load();
    await svc.listAll();
    expect(repo.find).toHaveBeenCalledWith({ order: { created_at: 'DESC' } });
  });
});
