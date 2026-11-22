// Date settings (Day End > Date settings): per window, the Day-End WORKING date (default) or the real SYSTEM date (India time).
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { DatePolicyService } from '../../../src/modules/admin/services/date-policy.service';
import { DATE_POLICY_WINDOWS, DATE_POLICY_KEYS, DATE_POLICY_FILE_FORMAT } from '../../../src/modules/admin/date-policy-windows';
import { getDatePolicyMode, resolvePostingDate, systemDateText, postingDateAsDate } from '../../../src/modules/shared/utils/posting-date';

type Runner = { query: jest.Mock };
const runner = (o: { table?: boolean; modes?: Record<string, string>; working?: string | null } = {}): Runner => ({
  query: jest.fn(async (sql: string, params?: any[]) => {
    if (/to_regclass/.test(sql)) return [{ t: o.table === false ? null : 'window_date_policy' }];
    if (/FROM window_date_policy WHERE window_key/.test(sql)) { const m = o.modes?.[params![0]]; return m ? [{ mode: m }] : []; }
    if (/FROM getworkingdate WHERE dayend_flag = 'N'/.test(sql)) return o.working ? [{ d: o.working }] : [];
    return [];
  }),
});

describe('systemDateText (today in India, from the server clock)', () => {
  it('uses the Indian calendar day, not UTC', () => {
    expect(systemDateText(new Date('2026-11-22T18:29:00Z'))).toBe('2026-11-22');  // 23:59 IST
    expect(systemDateText(new Date('2026-11-22T18:31:00Z'))).toBe('2026-11-23');  // 00:01 IST next day
    expect(systemDateText(new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01');
  });
  it('is always YYYY-MM-DD', () => expect(systemDateText()).toMatch(/^\d{4}-\d{2}-\d{2}$/));
  it('postingDateAsDate is local midnight of that day', () => {
    const d = postingDateAsDate('2026-08-25');
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()]).toEqual([2026, 8, 25, 0]);
  });
});

describe('getDatePolicyMode', () => {
  it('is WORKING when the table does not exist yet (and never queries it)', async () => {
    const r = runner({ table: false });
    expect(await getDatePolicyMode(r, 'LOAN_APP')).toBe('WORKING');
    expect(r.query.mock.calls.some((c) => /FROM window_date_policy/.test(c[0]))).toBe(false);
  });
  it('is WORKING when the window has no row', async () => expect(await getDatePolicyMode(runner(), 'LOAN_APP')).toBe('WORKING'));
  it('is SYSTEM when the client chose it (any letter case)', async () => {
    expect(await getDatePolicyMode(runner({ modes: { LOAN_APP: 'SYSTEM' } }), 'LOAN_APP')).toBe('SYSTEM');
    expect(await getDatePolicyMode(runner({ modes: { LOAN_APP: 'system' } }), 'LOAN_APP')).toBe('SYSTEM');
  });
  it('any other stored value is read as WORKING', async () => expect(await getDatePolicyMode(runner({ modes: { LOAN_APP: 'banana' } }), 'LOAN_APP')).toBe('WORKING'));
  it('each window has its own setting', async () => {
    const r = runner({ modes: { LOAN_APP: 'SYSTEM' } });
    expect(await getDatePolicyMode(r, 'LOAN_APP')).toBe('SYSTEM');
    expect(await getDatePolicyMode(r, 'RECEIPT_PAYMENT')).toBe('WORKING');
  });
});

describe('resolvePostingDate', () => {
  it('WORKING gives the open Day-End date', async () => {
    expect(await resolvePostingDate(runner({ working: '2026-08-25' }), 'RECEIPT_PAYMENT')).toEqual({ date: '2026-08-25', mode: 'WORKING', source: 'working-date' });
  });
  it('SYSTEM gives the real date even when a working date is open', async () => {
    const res = await resolvePostingDate(runner({ working: '2026-08-25', modes: { RECEIPT_PAYMENT: 'SYSTEM' } }), 'RECEIPT_PAYMENT');
    expect(res).toEqual({ date: systemDateText(), mode: 'SYSTEM', source: 'system-date' });
  });
  it('WORKING with no open day (Day-End never set up) falls back to the real date', async () => {
    const res = await resolvePostingDate(runner({ working: null }), 'RECEIPT_PAYMENT');
    expect(res).toEqual({ date: systemDateText(), mode: 'WORKING', source: 'system-date' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
const svcWith = (state: { rows?: any[]; current?: any[] } = {}) => {
  const qr: any = {
    connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(),
    query: jest.fn(async (sql: string) => (/SELECT window_key, mode FROM window_date_policy/.test(sql) ? state.current ?? [] : [])),
  };
  const ds: any = {
    query: jest.fn(async (sql: string) => (/SELECT window_key, mode, updated_by/.test(sql) ? state.rows ?? [] : [])),
    createQueryRunner: jest.fn(() => qr),
  };
  return { svc: new DatePolicyService(ds), ds, qr };
};

describe('DatePolicyService.list', () => {
  it('every window is WORKING by default', async () => {
    const rows = await svcWith().svc.list();
    expect(rows.length).toBe(DATE_POLICY_WINDOWS.length);
    expect(rows.every((r) => r.mode === 'WORKING' && r.changedBy === null)).toBe(true);
  });
  it('shows a saved setting with who changed it', async () => {
    const rows = await svcWith({ rows: [{ window_key: 'LOAN_APP', mode: 'SYSTEM', updated_by: 'admin', updated_at: new Date('2026-11-23T10:00:00Z') }] }).svc.list();
    const loan = rows.find((r) => r.key === 'LOAN_APP')!;
    expect(loan).toMatchObject({ mode: 'SYSTEM', changedBy: 'admin', changedAt: '2026-11-23T10:00:00.000Z' });
  });
});

describe('DatePolicyService.validate', () => {
  const { svc } = svcWith();
  it('accepts known windows with WORKING or SYSTEM (any case)', () => {
    expect(svc.validate([{ windowKey: 'LOAN_APP', mode: 'system' }, { windowKey: 'RECEIPT_PAYMENT', mode: 'WORKING' }])).toEqual([
      { windowKey: 'LOAN_APP', mode: 'SYSTEM' }, { windowKey: 'RECEIPT_PAYMENT', mode: 'WORKING' }]);
  });
  it.each([
    ['not a list', 'x', /must be a list/],
    ['unknown window', [{ windowKey: 'NOPE', mode: 'SYSTEM' }], /Unknown window "NOPE"/],
    ['bad mode', [{ windowKey: 'LOAN_APP', mode: 'TODAY' }], /must be WORKING or SYSTEM/],
    ['a window twice', [{ windowKey: 'LOAN_APP', mode: 'SYSTEM' }, { windowKey: 'LOAN_APP', mode: 'WORKING' }], /more than once/],
  ])('refuses %s', (_l, input, msg) => expect(() => svc.validate(input as any)).toThrow(msg as RegExp));
  it('names every problem in one message', () => {
    expect(() => svc.validate([{ windowKey: 'A', mode: 'SYSTEM' }, { windowKey: 'LOAN_APP', mode: 'x' }])).toThrow(/Unknown window "A".*must be WORKING or SYSTEM/);
  });
});

describe('DatePolicyService.save', () => {
  it('writes only the windows that really change, and logs each', async () => {
    const { svc, qr } = svcWith({ current: [{ window_key: 'LOAN_APP', mode: 'SYSTEM' }] });
    const res = await svc.save([
      { windowKey: 'LOAN_APP', mode: 'SYSTEM' },            // unchanged
      { windowKey: 'RECEIPT_PAYMENT', mode: 'SYSTEM' },     // WORKING -> SYSTEM
      { windowKey: 'JOURNAL_TRANSFER_ENTRY', mode: 'WORKING' }, // default -> same
    ], 'admin');
    expect(res).toMatchObject({ success: true, changed: 1, unchanged: 2 });
    expect(res.applied).toEqual([{ windowKey: 'RECEIPT_PAYMENT', from: 'WORKING', to: 'SYSTEM' }]);
    const writes = qr.query.mock.calls.filter((c: any[]) => /INSERT INTO/.test(c[0]));
    expect(writes).toHaveLength(2);                          // the setting and its log row
    expect(writes[1][1]).toEqual(['RECEIPT_PAYMENT', 'WORKING', 'SYSTEM', 'admin', 'screen']);
    expect(qr.commitTransaction).toHaveBeenCalled();
  });
  it('an invalid list writes nothing', async () => {
    const { svc, qr, ds } = svcWith();
    await expect(svc.save([{ windowKey: 'NOPE', mode: 'SYSTEM' }], 'admin')).rejects.toBeInstanceOf(BadRequestException);
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
    expect(qr.query).not.toHaveBeenCalled();
  });
  it('a failure rolls everything back and releases the connection', async () => {
    const { svc, qr } = svcWith();
    qr.query.mockImplementation(async (sql: string) => { if (/INSERT INTO window_date_policy \(/.test(sql)) throw new Error('db down'); return []; });
    await expect(svc.save([{ windowKey: 'LOAN_APP', mode: 'SYSTEM' }], 'admin')).rejects.toThrow('db down');
    expect(qr.rollbackTransaction).toHaveBeenCalled(); expect(qr.commitTransaction).not.toHaveBeenCalled(); expect(qr.release).toHaveBeenCalled();
  });
  it('an import is logged with its own source', async () => {
    const { svc, qr } = svcWith();
    await svc.save([{ windowKey: 'LOAN_APP', mode: 'SYSTEM' }], 'admin', 'import');
    expect(qr.query.mock.calls.find((c: any[]) => /window_date_policy_log/.test(c[0]))[1][4]).toBe('import');
  });
});

describe('DatePolicyService export and import', () => {
  it('exports every window with its mode in a versioned file', async () => {
    const file = await svcWith({ rows: [{ window_key: 'LOAN_APP', mode: 'SYSTEM', updated_by: 'a', updated_at: new Date() }] }).svc.exportFile();
    expect(file).toMatchObject({ format: DATE_POLICY_FILE_FORMAT, version: 1 });
    expect(Object.keys(file.windows)).toHaveLength(DATE_POLICY_WINDOWS.length);
    expect(file.windows['LOAN_APP']).toBe('SYSTEM');
    expect(file.windows['RECEIPT_PAYMENT']).toBe('WORKING');
  });
  it('an exported file imports back with nothing to change', async () => {
    const { svc } = svcWith({ rows: [{ window_key: 'LOAN_APP', mode: 'SYSTEM', updated_by: 'a', updated_at: new Date() }] });
    const pre = await svc.previewImport(await svc.exportFile());
    expect(pre.willChange).toEqual([]);
    expect(pre.unchanged).toBe(DATE_POLICY_WINDOWS.length);
  });
  it('previews what a file would change, by window name', async () => {
    const { svc } = svcWith();
    const pre = await svc.previewImport({ format: DATE_POLICY_FILE_FORMAT, version: 1, windows: { LOAN_APP: 'SYSTEM', RECEIPT_PAYMENT: 'WORKING' } });
    expect(pre.willChange).toEqual([{ windowKey: 'LOAN_APP', label: 'Loan Application (application date)', from: 'WORKING', to: 'SYSTEM' }]);
    expect(pre.unchanged).toBe(1);
  });
  it('windows left out of a file are not changed', async () => {
    const pre = await svcWith().svc.previewImport({ format: DATE_POLICY_FILE_FORMAT, version: 1, windows: { LOAN_APP: 'SYSTEM' } });
    expect(pre.changes).toHaveLength(1);
  });
  it.each([
    ['wrong format', { format: 'other', version: 1, windows: {} }, /not a Date settings file/],
    ['null', null, /not a Date settings file/],
    ['a newer version', { format: DATE_POLICY_FILE_FORMAT, version: 99, windows: {} }, /newer version/],
    ['no windows', { format: DATE_POLICY_FILE_FORMAT, version: 1 }, /no "windows" section/],
    ['windows as a list', { format: DATE_POLICY_FILE_FORMAT, version: 1, windows: [] }, /no "windows" section/],
    ['an unknown window', { format: DATE_POLICY_FILE_FORMAT, version: 1, windows: { NOPE: 'SYSTEM' } }, /Unknown window/],
    ['a bad value', { format: DATE_POLICY_FILE_FORMAT, version: 1, windows: { LOAN_APP: 'NOW' } }, /WORKING or SYSTEM/],
  ])('rejects %s', async (_l, file, msg) => { await expect(svcWith().svc.previewImport(file)).rejects.toThrow(msg as RegExp); });
});

describe('DatePolicyService start-up and history', () => {
  it('creates the two tables, and never blocks start-up if that fails', async () => {
    const ok = svcWith(); await ok.svc.onModuleInit();
    expect(ok.ds.query.mock.calls.filter((c: any[]) => /CREATE TABLE IF NOT EXISTS/.test(c[0]))).toHaveLength(2);
    const bad = svcWith(); bad.ds.query.mockRejectedValue(new Error('no rights'));
    await expect(bad.svc.onModuleInit()).resolves.toBeUndefined();
  });
  it('history is newest first and its limit is kept between 1 and 500', async () => {
    const { svc, ds } = svcWith();
    for (const [given, used] of [[undefined, 100], [0, 1], [-4, 1], [20, 20], [9999, 500], [NaN, 100]]) {
      ds.query.mockClear(); await svc.history(given as any);
      expect(ds.query.mock.calls[0][1]).toEqual([used]);
      expect(ds.query.mock.calls[0][0]).toMatch(/ORDER BY id DESC/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('window list integrity', () => {
  it('keys are unique and every window has a label and area', () => {
    expect(DATE_POLICY_KEYS.size).toBe(DATE_POLICY_WINDOWS.length);
    for (const w of DATE_POLICY_WINDOWS) { expect(w.label.length).toBeGreaterThan(2); expect(w.area.length).toBeGreaterThan(1); expect(['posts', 'stores']).toContain(w.kind); }
  });

  // "wired" must be the truth: a window is marked wired exactly when some backend code asks for its date with its key.
  it('a window is marked wired exactly when the backend calls resolvePostingDate with its key', () => {
    const srcRoot = path.resolve(__dirname, '../../../src');
    const used = new Set<string>();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !p.endsWith('posting-date.ts')) {
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/resolvePostingDate\([^,]+,\s*'([A-Z0-9_]+)'\)/g)) used.add(m[1]!);
        }
      }
    };
    walk(srcRoot);
    const wired = new Set(DATE_POLICY_WINDOWS.filter((w) => w.wired).map((w) => w.key));
    expect([...used].sort()).toEqual([...wired].sort());
    for (const key of used) expect(DATE_POLICY_KEYS.has(key)).toBe(true);
  });
});
