import * as crypto from 'crypto';

// Signed license keys (format 2) and the end of the shared-secret format (ES-393).
const SECRET = 'PWT_LMS_SECRET_KEY_2025_CHANGE_IN_PROD';
const DAY = 86_400_000;
process.env.LICENSE_SECRET = SECRET;
process.env.LICENSE_LEGACY_UNTIL = '2999-12-31';

const lib = require('../../../license-key-lib');

function makeLegacyKey(customer: string, expiry: Date): string {
  const enc = Math.floor(expiry.getTime() / DAY).toString(36).toUpperCase().padStart(4, '0');
  const sig = crypto.createHmac('sha256', SECRET).update(`${customer}${enc}`).digest('hex').toUpperCase().slice(0, 8);
  return `PWT0-${customer}-${enc}-${sig.slice(0, 4)}-${sig.slice(4)}`;
}

/** Fresh module per test: the service keeps a day-cache in a module variable. */
function load() {
  let LicenseService: any;
  jest.isolateModules(() => {
    LicenseService = require('../../../src/modules/license/license.service').LicenseService;
  });
  const qb: any = { update: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), execute: jest.fn().mockResolvedValue({}), getOne: jest.fn() };
  const repo: any = {
    createQueryBuilder: jest.fn().mockReturnValue(qb), findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((x) => ({ ...x })), save: jest.fn(async (x) => x), find: jest.fn().mockResolvedValue([]), query: jest.fn().mockResolvedValue([]),
  };
  return { svc: new LicenseService(repo), repo };
}
const inDays = (n: number) => new Date(Date.now() + n * DAY);
const pair = () => crypto.generateKeyPairSync('ed25519');
const useKey = (kp: crypto.KeyObject) => { process.env.LICENSE_PUBLIC_KEY = (kp.export({ type: 'spki', format: 'pem' }) as string).replace(/\n/g, '\\n'); };

describe('license/activate signed keys, format 2 (ES-393)', () => {
  afterEach(() => { delete process.env.LICENSE_PUBLIC_KEY; process.env.LICENSE_SECRET = SECRET; process.env.LICENSE_LEGACY_UNTIL = '2999-12-31'; });

  it('a key signed by the issuer activates, with no shared secret on this machine', async () => {
    const kp = pair(); useKey(kp.publicKey); delete process.env.LICENSE_SECRET;
    const { svc, repo } = load();
    const r = await svc.activate({ key: lib.signKeyV2(kp.privateKey, 'ACME', inDays(100)) });
    expect(r.status).toBe('active');
    expect(r.customer_name).toBe('ACME');
    expect(repo.save).toHaveBeenCalled();
  });
  it('the key looks like PWT1-CCCC-DDDD-<groups of 8> and is about 120 characters', () => {
    const k: string = lib.signKeyV2(pair().privateKey, 'ACME', inDays(10));
    expect(k).toMatch(/^PWT1-ACME-[0-9A-Z]{4}-([A-Z2-7]{8}-)+[A-Z2-7]{1,8}$/);
    expect(k.length).toBeGreaterThan(110);
    expect(k.length).toBeLessThan(140);
  });
  it('a key signed by someone else is rejected and nothing is saved', async () => {
    useKey(pair().publicKey);
    const { svc, repo } = load();
    await expect(svc.activate({ key: lib.signKeyV2(pair().privateKey, 'ACME', inDays(100)) })).rejects.toMatchObject({ status: 400 });
    expect(repo.save).not.toHaveBeenCalled();
  });
  it('changing the customer or the expiry of a genuine key breaks the signature', async () => {
    const kp = pair(); useKey(kp.publicKey);
    const { svc } = load();
    const k: string = lib.signKeyV2(kp.privateKey, 'ACME', inDays(30));
    await expect(svc.activate({ key: k.replace('PWT1-ACME-', 'PWT1-EVIL-') })).rejects.toMatchObject({ status: 400 });
    const parts = k.split('-');
    parts[2] = lib.expiryEncoded(inDays(3000));
    await expect(svc.activate({ key: parts.join('-') })).rejects.toMatchObject({ status: 400 });
  });
  it('a damaged signature, a truncated key and junk are rejected', async () => {
    const kp = pair(); useKey(kp.publicKey);
    const { svc } = load();
    const k: string = lib.signKeyV2(kp.privateKey, 'ACME', inDays(30));
    for (const bad of [k.slice(0, -9), k.slice(0, -1) + (k.endsWith('A') ? 'B' : 'A'), 'PWT1-ACME-0000-AAAAAAAA', 'PWT1-----']) {
      await expect(svc.activate({ key: bad })).rejects.toMatchObject({ status: 400 });
    }
  });
  it('an expired genuine key is refused', async () => {
    const kp = pair(); useKey(kp.publicKey);
    await expect(load().svc.activate({ key: lib.signKeyV2(kp.privateKey, 'ACME', inDays(-5)) })).rejects.toMatchObject({ status: 400 });
  });
  it('spaces, line breaks and lower case from pasting are tolerated', async () => {
    const kp = pair(); useKey(kp.publicKey);
    const k: string = lib.signKeyV2(kp.privateKey, 'ACME', inDays(100));
    const r = await load().svc.activate({ key: '  ' + k.toLowerCase().replace(/-/g, '-\n') + '\n' });
    expect(r.status).toBe('active');
  });
  it('the full key is stored, not a shortened one', async () => {
    const kp = pair(); useKey(kp.publicKey);
    const { svc, repo } = load();
    const k: string = lib.signKeyV2(kp.privateKey, 'ACME', inDays(100));
    await svc.activate({ key: k });
    expect(repo.create.mock.calls[0][0].key).toBe(k);
  });
  it('the old shared secret cannot be used to forge a PWT1 key', async () => {
    useKey(pair().publicKey);
    const fake = crypto.createHmac('sha256', SECRET).update('PWT1|ACME').digest().subarray(0, 32);
    const forged = `PWT1-ACME-${lib.expiryEncoded(inDays(100))}-${lib.b32encode(Buffer.concat([fake, fake])).match(/.{1,8}/g)!.join('-')}`;
    await expect(load().svc.activate({ key: forged })).rejects.toMatchObject({ status: 400 });
  });
  it('rotating the key pair needs only the new public key in .env (the old one stops working)', async () => {
    const oldPair = pair(); const newPair = pair();
    const oldKey: string = lib.signKeyV2(oldPair.privateKey, 'ACME', inDays(100));
    const newKey: string = lib.signKeyV2(newPair.privateKey, 'ACME', inDays(100));
    useKey(newPair.publicKey);
    await expect(load().svc.activate({ key: oldKey })).rejects.toMatchObject({ status: 400 });
    expect((await load().svc.activate({ key: newKey })).status).toBe('active');
  });
});

describe('license/activate old format (PWT0) only during the overlap (ES-393)', () => {
  afterEach(() => { process.env.LICENSE_LEGACY_UNTIL = '2999-12-31'; process.env.LICENSE_SECRET = SECRET; });
  it('refused with a clear message when LICENSE_LEGACY_UNTIL is not set', async () => {
    delete process.env.LICENSE_LEGACY_UNTIL;
    await expect(load().svc.activate({ key: makeLegacyKey('ACME', inDays(100)) })).rejects.toThrow(/old format/);
  });
  it('refused after the overlap date has passed', async () => {
    process.env.LICENSE_LEGACY_UNTIL = '2020-01-01';
    await expect(load().svc.activate({ key: makeLegacyKey('ACME', inDays(100)) })).rejects.toMatchObject({ status: 400 });
  });
  it('accepted while the overlap date is in the future', async () => {
    process.env.LICENSE_LEGACY_UNTIL = '2999-01-01';
    expect((await load().svc.activate({ key: makeLegacyKey('ACME', inDays(100)) })).status).toBe('active');
  });
  it('a malformed overlap date counts as "no overlap"', async () => {
    process.env.LICENSE_LEGACY_UNTIL = 'soon';
    await expect(load().svc.activate({ key: makeLegacyKey('ACME', inDays(100)) })).rejects.toMatchObject({ status: 400 });
  });
  it('during the overlap a missing LICENSE_SECRET is still a 503', async () => {
    delete process.env.LICENSE_SECRET;
    await expect(load().svc.activate({ key: makeLegacyKey('ACME', inDays(100)) })).rejects.toMatchObject({ status: 503 });
  });
});

describe('license/key column and request format', () => {
  it('start-up widens the key column to 200 characters and survives a failure', async () => {
    const { svc, repo } = load();
    await svc.onModuleInit();
    expect(repo.query.mock.calls[0][0]).toMatch(/ALTER COLUMN "key" TYPE VARCHAR\(200\)/);
    repo.query = jest.fn().mockRejectedValue(new Error('no permission'));
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });
  it('the request check accepts both formats and rejects junk', async () => {
    const { validate } = require('class-validator');
    const { plainToInstance } = require('class-transformer');
    const { ActivateLicenseDto } = require('../../../src/modules/license/dto/license.dto');
    const ok = async (key: string) => (await validate(plainToInstance(ActivateLicenseDto, { key }))).length === 0;
    expect(await ok('PWT0-ABCD-1234-ABCD-1234')).toBe(true);
    expect(await ok('PWT1-ACME-1ABC-' + 'ABCDEFGH-'.repeat(12) + 'ABCDEFG')).toBe(true);
    expect(await ok('PWT9-ABCD-1234-ABCD-1234')).toBe(false);
    expect(await ok('PWT1-')).toBe(false);
    expect(await ok('')).toBe(false);
  });
  it('the backend code never contains or reads a private key', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '../../../src/modules/license');
    for (const f of fs.readdirSync(dir).filter((x: string) => x.endsWith('.ts'))) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/PRIVATE KEY|license-private|createPrivateKey|crypto\.sign\(/);
    }
  });
  it('the project files hold no private key', () => {
    const fs = require('fs');
    const path = require('path');
    for (const f of ['license-key-lib.js', 'generate-license.js']) {
      expect(fs.readFileSync(path.join(__dirname, '../../..', f), 'utf8')).not.toMatch(/-----BEGIN (ENCRYPTED )?PRIVATE KEY-----/);
    }
  });
});
