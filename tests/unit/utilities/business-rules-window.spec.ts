// Modify Business Rules (backend): what the window reads from and writes to busrules / system_configs.
// Everything is mocked: no rule in any database is read or written by this file.
// Tests named "KNOWN BUG" use it.failing: they describe the CORRECT behaviour, fail today, and turn into normal passing
// tests (jest then reports them as failing-to-pass) the day the bug is fixed.
import { BadRequestException } from '@nestjs/common';
import { UtilitiesService } from '../../../src/modules/utilities/utilities.service';

// The legacy BUSRULES row 4032 (latest, 2025-11-19), as the legacy "Modify Business Rules" screen shows it.
const LEGACY_4032 = {
  srno: '4032', appdate: '2025-11-19T00:00:00',
  rlnmaxloanamt: '1000000', rlnrate: '12.00', rlnpenalrate: '3.00', rlnmaxnoinst: '50', rlnnogr: '2',
  elnmaxloanamt: '1000000', elnrate: '7.00', elnmaxnoinst: '120', elnnogr: '0',
  alnmaxloanamt: '500000', alnrate: '12.00', alnmaxnoinst: '100', alnnogr: '0',
  mlnmaxloanamt: '25000', mlnrate: '13.00', mlnmaxnoinst: '10', mlnnogr: '0',
  minmembship: '25', minshareamt: '0', maxshareamt: '0', mincdamt: '200', maxcdamt: '200',
  edlmaxloanamt: '0', edlrate: '0.00', edlmaxnoinst: '0', edlnogr: '0',
  flnmaxloanamt: '500000', flnrate: '2', flnmaxnoinst: '50', flnnogr: '0',
  dataentryflag: 'N', print_demand_horizontal: 'Y', emi_based_demand: 'Y', minsavingbalance: '0',
  reducingbal_intt_calc: 'Y', intt_slot: 0, loanmaxlimit: '500000', loanagainstbasic: '0', loanagainstdeppercent: '90',
  consolidateinttamountindemand: 'N', considerintt: 'N', profit_head_code: null,
  alnpenalrate: '15.00', elnpenalrate: '50.00', rlngracedays: 15, elngracedays: 0, alngracedays: 15,
  rlnsmpct: '1.00', elnsmpct: '1.00', alnsmpct: '1.00', rlnsmdiv: '4.00', elnsmdiv: '4.00', alnsmdiv: '4.00',
};

const FULL = {
  RULE_LOAN_R_MAX_AMT: 1000000, RULE_LOAN_R_RATE: 12, RULE_LOAN_R_INSTALLMENTS: 50, RULE_LOAN_R_GUARANTORS: 2, RULE_PENAL_RATE: 3, RULE_LOAN_R_GRACE_DAYS: 15, RULE_LOAN_R_SM_PCT: 1, RULE_LOAN_R_SM_DIV: 4,
  RULE_LOAN_ADD_MAX_AMT: 500000, RULE_LOAN_ADD_RATE: 12, RULE_LOAN_ADD_INSTALLMENTS: 100, RULE_LOAN_ADD_GUARANTORS: 0, RULE_LOAN_ADD_PENAL_RATE: 15, RULE_LOAN_ADD_GRACE_DAYS: 15, RULE_LOAN_ADD_SM_PCT: 1, RULE_LOAN_ADD_SM_DIV: 4,
  RULE_LOAN_EMG_MAX_AMT: 1000000, RULE_LOAN_EMG_RATE: 7, RULE_LOAN_EMG_INSTALLMENTS: 120, RULE_LOAN_EMG_GUARANTORS: 0, RULE_LOAN_EMG_PENAL_RATE: 50, RULE_LOAN_EMG_GRACE_DAYS: 0, RULE_LOAN_EMG_SM_PCT: 1, RULE_LOAN_EMG_SM_DIV: 4,
  RULE_LOAN_MT_MAX_AMT: 25000, RULE_LOAN_MT_RATE: 13, RULE_LOAN_MT_INSTALLMENTS: 10, RULE_LOAN_MT_GUARANTORS: 0,
  RULE_LOAN_DEP_MAX_AMT: 500000, RULE_LOAN_DEP_RATE: 2, RULE_LOAN_DEP_INSTALLMENTS: 50, RULE_LOAN_DEP_GUARANTORS: 0,
  RULE_LOAN_DEP_SHARE_VAL_PCT: 0, RULE_LOAN_DEP_FD_PCT: 90, RULE_LOAN_DEP_OVERALL_LIMIT: 500000,
  RULE_MEMBER_MIN_TENURE_MONTHS: 25, RULE_SHARE_MIN_AMT: 0, RULE_SHARE_MAX_AMT: 0,
  SYS_DATA_ENTRY_MODE: false, SYS_PRINT_DEMAND_HORIZONTAL: true, SYS_USE_REDUCING_BALANCE: true, SYS_MIN_SAVINGS_BALANCE: 0,
  SYS_SHOW_CONSOLIDATED_INT_IN_DEMAND: false, SYS_CONSIDER_INT_BEFORE_10TH: false, SYS_AVG_INT_CALC_SLOT: 0, SYS_PROFIT_HEAD: 'I1002',
};

const build = (opts: { busrulesRow?: any; failUpsert?: boolean; rollbackThrows?: boolean } = {}) => {
  const sql: Array<{ sql: string; params?: any[] }> = [];
  const events: string[] = [];
  const qr: any = {
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => { events.push('begin'); }),
    commitTransaction: jest.fn(async () => { events.push('commit'); }),
    rollbackTransaction: jest.fn(async () => {
      events.push('rollback');
      if (opts.rollbackThrows) throw new Error('TransactionNotStartedError: Transaction is not started yet, start transaction before committing or rolling it back.');
    }),
    release: jest.fn(async () => undefined),
    query: jest.fn(async (s: string, p?: any[]) => { sql.push({ sql: s, params: p }); events.push('insert-busrules'); return []; }),
  };
  const ds: any = {
    createQueryRunner: jest.fn(() => qr),
    query: jest.fn(async (s: string, p?: any[]) => {
      sql.push({ sql: s, params: p });
      if (/FROM busrules/.test(s) && opts.busrulesRow) return [opts.busrulesRow];
      if (/SELECT CURRENT_DATE/.test(s)) return [{ today: '2026-11-26' }];
      if (/FROM system_configs WHERE key = ANY/.test(s)) return [];
      if (/^UPDATE system_configs/.test(s)) {
        events.push('upsert');
        if (opts.failUpsert) throw new Error('connection lost');
        return [[{ id: 1 }], 1];
      }
      return [];
    }),
  };
  return { svc: new UtilitiesService(ds, {} as any, {} as any), sql, events, qr, ds };
};

describe('reading: busrules columns become the screen fields (legacy row 4032 as the fixture)', () => {
  it('Regular Loan = RLN; "Emergency Loan" = ALN; "Loan Against RD" = ELN; Grain = MLN (the same pairing as the legacy screen)', async () => {
    const { svc } = build({ busrulesRow: LEGACY_4032 });
    const r = await svc.getBusinessRules();
    expect([r.RULE_LOAN_R_MAX_AMT, r.RULE_LOAN_R_RATE, r.RULE_LOAN_R_INSTALLMENTS, r.RULE_LOAN_R_GUARANTORS]).toEqual(['1000000', '12.00', '50', '2']);
    expect([r.RULE_LOAN_ADD_MAX_AMT, r.RULE_LOAN_ADD_RATE, r.RULE_LOAN_ADD_INSTALLMENTS]).toEqual(['500000', '12.00', '100']); // legacy "Emergency Loan"
    expect([r.RULE_LOAN_EMG_MAX_AMT, r.RULE_LOAN_EMG_RATE, r.RULE_LOAN_EMG_INSTALLMENTS]).toEqual(['1000000', '7.00', '120']); // legacy "Loan Against R"
    expect([r.RULE_LOAN_MT_MAX_AMT, r.RULE_LOAN_MT_RATE, r.RULE_LOAN_MT_INSTALLMENTS]).toEqual(['25000', '13.00', '10']); // legacy "Grain Loan"
  });

  it('the legacy "Penal Rate" is the Regular loan penal rate; others, limits and flags come through', async () => {
    const { svc } = build({ busrulesRow: LEGACY_4032 });
    const r = await svc.getBusinessRules();
    expect(r.RULE_PENAL_RATE).toBe('3.00');
    expect(r.RULE_LOAN_DEP_OVERALL_LIMIT).toBe('500000');
    expect(r.RULE_LOAN_DEP_FD_PCT).toBe('90');
    expect(r.RULE_MEMBER_MIN_TENURE_MONTHS).toBe('25');
    expect(r.SYS_PRINT_DEMAND_HORIZONTAL).toBe(true);
    expect(r.SYS_DATA_ENTRY_MODE).toBe(false);
    expect(r.SYS_USE_REDUCING_BALANCE).toBe(true);
  });

  it('Share Value % and Basic Pay both come from the one column loanagainstbasic (the legacy has one column for them)', async () => {
    const { svc } = build({ busrulesRow: { ...LEGACY_4032, loanagainstbasic: '7' } });
    const r = await svc.getBusinessRules();
    expect(r.RULE_LOAN_DEP_SHARE_VAL_PCT).toBe('7');
    expect(r.RULE_LOAN_DEP_BASIC_PAY).toBe('7');
  });

  it('Min / Max CD amount and Security Deposit are no longer shown (CD min lives in the RD tab; security deposit has no column)', async () => {
    const { svc } = build({ busrulesRow: LEGACY_4032 });
    const r = await svc.getBusinessRules();
    expect(r).not.toHaveProperty('RULE_CD_MIN_AMT');
    expect(r).not.toHaveProperty('RULE_CD_MAX_AMT');
    expect(r.RULE_SECURITY_DEP_AMT).toBe(0);
  });

  it('no rules row at all: an empty answer, never a crash', async () => {
    const { svc } = build();
    expect(await svc.getBusinessRules()).toEqual({});
  });

  it('the settings kept in system_configs are added, with safe defaults when nothing is stored', async () => {
    const { svc } = build({ busrulesRow: LEGACY_4032 });
    const r = await svc.getBusinessRules();
    expect(r.RULE_LOAN_SLOT1_START_DAY).toBe(25);
    expect(r.RULE_LOAN_SLOT1_END_DAY).toBe(5);
    expect(r.RULE_LOAN_ROUNDING_MODE).toBe('NEAREST');
    expect(r.RULE_DEMAND_IMPORT_STRICTNESS).toBe('STRICT');
    expect(r.RULE_LOAN_ELIGIBILITY_APPLY_ELN).toBe(true);
  });
});

describe('writing: the INSERT into busrules', () => {
  /** columns -> params of the busrules INSERT, so a shifted parameter can never hide */
  const insertOf = (sql: Array<{ sql: string; params?: any[] }>) => {
    const ins = sql.find((x) => /INSERT INTO busrules/.test(x.sql))!;
    const cols = /INSERT INTO busrules \(([\s\S]*?)\) VALUES/.exec(ins.sql)![1].split(',').map((c) => c.trim());
    const out: Record<string, any> = { appdate: 'NOW()' };
    cols.slice(1).forEach((c, i) => { out[c] = ins.params![i]; });
    return { cols, out, ins };
  };

  it('every screen value lands in the column the legacy uses for it', async () => {
    const { svc, sql } = build();
    await svc.updateBusinessRules(FULL);
    const { out, cols, ins } = insertOf(sql);
    expect(cols).toHaveLength(ins.params!.length + 1); // appdate has no parameter
    expect(out).toMatchObject({
      rlnmaxloanamt: 1000000, rlnrate: 12, rlnpenalrate: 3, rlnmaxnoinst: 50, rlnnogr: 2,
      elnmaxloanamt: 1000000, elnrate: 7, elnmaxnoinst: 120, elnnogr: 0,
      alnmaxloanamt: 500000, alnrate: 12, alnmaxnoinst: 100, alnnogr: 0,
      mlnmaxloanamt: 25000, mlnrate: 13, mlnmaxnoinst: 10, mlnnogr: 0,
      edlmaxloanamt: 500000, edlrate: 2, edlmaxnoinst: 50, edlnogr: 0,
      minmembship: 25, minshareamt: 0, maxshareamt: 0,
      loanmaxlimit: 500000, loanagainstbasic: 0, loanagainstdeppercent: 90,
      dataentryflag: 'N', print_demand_horizontal: 'Y', reducingbal_intt_calc: 1, minsavingbalance: 0,
      consolidateinttamountindemand: 0, considerintt: 'N', intt_slot: 0, profit_head_code: 'I1002',
      alnpenalrate: 15, elnpenalrate: 50, rlngracedays: 15, rlnsmpct: 1, rlnsmdiv: 4, alngracedays: 15, elngracedays: 0,
    });
  });

  it('a save adds a NEW row (the legacy pattern: history is kept); it never updates or deletes an old one', async () => {
    const { svc, sql } = build();
    await svc.updateBusinessRules(FULL);
    const writes = sql.map((x) => x.sql.trim().split(/\s+/)[0].toUpperCase());
    expect(writes.filter((w) => w === 'INSERT')).toHaveLength(1);
    expect(sql.some((x) => /^(UPDATE|DELETE)\s+busrules/i.test(x.sql.trim()))).toBe(false);
  });

  it('what a save does NOT carry forward (current behaviour, listed in the findings): CD min/max become 0 and the FLN/SLN columns are left empty', async () => {
    const { svc, sql } = build();
    await svc.updateBusinessRules(FULL);
    const { out, cols } = insertOf(sql);
    expect(out.mincdamt).toBe(0);
    expect(out.maxcdamt).toBe(0);
    expect(cols).not.toContain('flnmaxloanamt');
    expect(cols).not.toContain('emi_based_demand');
  });

  it('the on/off switches are written as Y / N, reducing balance as 1 / 0', async () => {
    const { svc, sql } = build();
    await svc.updateBusinessRules({ ...FULL, SYS_DATA_ENTRY_MODE: true, SYS_PRINT_DEMAND_HORIZONTAL: false, SYS_USE_REDUCING_BALANCE: false, SYS_CONSIDER_INT_BEFORE_10TH: true });
    const { out } = insertOf(sql);
    expect([out.dataentryflag, out.print_demand_horizontal, out.reducingbal_intt_calc, out.considerintt]).toEqual(['Y', 'N', 0, 'Y']);
  });

  it('the settings kept in system_configs are written too (slots, rounding, eligibility)', async () => {
    const { svc, sql } = build();
    await svc.updateBusinessRules({ ...FULL, RULE_LOAN_ROUNDING_MODE: 'UP', RULE_LOAN_SLOT1_START_DAY: 40, RULE_LOAN_SLOT1_END_DAY: 0 });
    const w = (k: string) => sql.find((x) => /^UPDATE system_configs/.test(x.sql) && x.params?.[2] === k)?.params;
    expect(w('RULE_LOAN_ROUNDING_MODE')?.[0]).toBe('UP');
    expect(w('RULE_LOAN_SLOT1_START_DAY')?.[0]).toBe('25'); // out of 1-31: silently replaced by the default (finding: no message to the user)
    expect(w('RULE_LOAN_SLOT1_END_DAY')?.[0]).toBe('5');
    expect(w('RULE_LOAN_ELIGIBILITY_APPLY_ELN')?.[0]).toBe('true'); // Loan Against RD's check is always on
  });

  it('a bad rounding word is stored as NEAREST, a bad strictness as STRICT (never loosened)', async () => {
    const { svc, sql } = build();
    await svc.updateBusinessRules({ ...FULL, RULE_LOAN_ROUNDING_MODE: 'HALF', RULE_DEMAND_IMPORT_STRICTNESS: 'whatever' });
    const w = (k: string) => sql.find((x) => /^UPDATE system_configs/.test(x.sql) && x.params?.[2] === k)?.params?.[0];
    expect(w('RULE_LOAN_ROUNDING_MODE')).toBe('NEAREST');
    expect(w('RULE_DEMAND_IMPORT_STRICTNESS')).toBe('STRICT');
  });
});

describe('validation (ES-293 / ES-356 / ES-482)', () => {
  it.each([
    ['empty body', {}], ['array body', [1, 2, 3]], ['only an unknown key', { __x: 1 }],
  ])('%s is refused with 400 and nothing is written', async (_n, body) => {
    const { svc, qr } = build();
    await expect(svc.updateBusinessRules(body as any)).rejects.toThrow(BadRequestException);
    expect(qr.query).not.toHaveBeenCalled();
    expect(qr.startTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['RULE_LOAN_R_RATE', '-5'], ['RULE_LOAN_R_RATE', 'abc'], ['RULE_LOAN_R_RATE', ''], ['RULE_LOAN_R_RATE', null], ['RULE_LOAN_R_RATE', undefined],
    ['RULE_PENAL_RATE', -1], ['RULE_LOAN_ADD_GRACE_DAYS', -2], ['RULE_LOAN_EMG_MAX_AMT', NaN], ['RULE_LOAN_EMG_INSTALLMENTS', Infinity],
  ])('the loan limit %s = %j is refused (400)', async (key, value) => {
    const { svc, qr } = build();
    await expect(svc.updateBusinessRules({ ...FULL, [key]: value })).rejects.toThrow(BadRequestException);
    expect(qr.query).not.toHaveBeenCalled();
  });

  it('every one of the 15 required loan keys, when missing, is named in the answer', async () => {
    const { svc } = build();
    const err: any = await svc.updateBusinessRules({}).catch((e) => e);
    for (const k of ['RULE_LOAN_R_MAX_AMT', 'RULE_LOAN_ADD_RATE', 'RULE_LOAN_EMG_GRACE_DAYS', 'RULE_PENAL_RATE']) expect(String(err.message)).toContain(k);
  });

  it('zero is a valid value (a society may set a limit or grace to 0)', async () => {
    const { svc } = build();
    await expect(svc.updateBusinessRules({ ...FULL, RULE_LOAN_R_GRACE_DAYS: 0, RULE_LOAN_EMG_MAX_AMT: 0 })).resolves.toMatchObject({ success: true });
  });

  it('a dividend rule that contradicts itself is refused before anything is saved (ES-476)', async () => {
    const { svc, qr } = build();
    await expect(svc.updateBusinessRules({
      ...FULL, RULE_DIVIDEND_FIXED_PCT: 5, RULE_DIVIDEND_FIXED_ACTIVE: true, RULE_DIVIDEND_MIN_PCT: 9, RULE_DIVIDEND_MIN_ACTIVE: true,
      RULE_DIVIDEND_MAX_PCT: 7, RULE_DIVIDEND_MAX_ACTIVE: true,
    })).rejects.toThrow();
    expect(qr.query).not.toHaveBeenCalled();
  });

  // ── KNOWN BUGS (reported, not fixed): correct behaviour written as it.failing ──
  it.failing('KNOWN BUG: a loan rate above 100 % is refused (the screen refuses it, the server accepts RULE_LOAN_R_RATE = 5000)', async () => {
    const { svc } = build();
    await expect(svc.updateBusinessRules({ ...FULL, RULE_LOAN_R_RATE: 5000 })).rejects.toThrow(BadRequestException);
  });

  it.failing('KNOWN BUG: a negative value in a field outside the 15 required ones is refused (RULE_LOAN_DEP_RATE = -5 is saved as -5)', async () => {
    const { svc } = build();
    await expect(svc.updateBusinessRules({ ...FULL, RULE_LOAN_DEP_RATE: -5 })).rejects.toThrow(BadRequestException);
  });

  it.failing('KNOWN BUG: a negative minimum membership or share amount is refused', async () => {
    const { svc } = build();
    await expect(svc.updateBusinessRules({ ...FULL, RULE_MEMBER_MIN_TENURE_MONTHS: -3, RULE_SHARE_MIN_AMT: -100 })).rejects.toThrow(BadRequestException);
  });

  it.failing('KNOWN BUG: text in a field outside the 15 required ones is a clear 400 (today it reaches the database and comes back as a generic failure)', async () => {
    const { svc } = build();
    await expect(svc.updateBusinessRules({ ...FULL, RULE_SHARE_MAX_AMT: 'abc' })).rejects.toThrow(BadRequestException);
  });

  it.failing('KNOWN BUG: the same-month penal divisor cannot be saved as 0 (it divides the same-month fee)', async () => {
    const { svc } = build();
    await expect(svc.updateBusinessRules({ ...FULL, RULE_LOAN_R_SM_DIV: 0 })).rejects.toThrow(BadRequestException);
  });
});

describe('a failure half-way (atomicity)', () => {
  it.failing('KNOWN BUG: the new busrules row and the system_configs settings are saved together or not at all (today the row is committed first, so a failed settings write leaves a half save)', async () => {
    const { svc, events } = build({ failUpsert: true });
    await svc.updateBusinessRules(FULL).catch(() => undefined);
    expect(events).not.toContain('commit'); // nothing may be committed when a later write failed
  });

  it.failing('KNOWN BUG: the real error is shown when the settings write fails after the commit (today a rollback of the already-committed transaction replaces it with "Transaction is not started")', async () => {
    const { svc } = build({ failUpsert: true, rollbackThrows: true });
    const err: any = await svc.updateBusinessRules(FULL).catch((e) => e);
    expect(String(err.message)).toMatch(/connection lost/);
  });

  it('a failure before the commit rolls back and shows the real reason', async () => {
    const { svc, qr } = build();
    qr.query.mockRejectedValueOnce(new Error('numeric field overflow'));
    await expect(svc.updateBusinessRules(FULL)).rejects.toThrow(/numeric field overflow/);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    expect(qr.release).toHaveBeenCalled();
  });
});

describe('which row is "the latest" (the same-day rows of the migrated legacy history)', () => {
  it.failing('KNOWN BUG: the latest row is chosen by date AND serial number (the migrated history has 976 days with two or more rows, e.g. 4031 and 4032 on 2025-11-19 differ in Emergency instalments 80 / 100)', async () => {
    const { svc, sql } = build({ busrulesRow: LEGACY_4032 });
    await svc.getBusinessRules();
    const read = sql.find((x) => /FROM busrules/.test(x.sql))!;
    expect(read.sql).toMatch(/srno/i);
  });
});

describe('stress', () => {
  it('50 saves in a row each add exactly one row and one set of settings writes', async () => {
    const { svc, sql } = build();
    for (let i = 0; i < 50; i++) await svc.updateBusinessRules({ ...FULL, RULE_LOAN_R_RATE: 5 + (i % 10) });
    expect(sql.filter((x) => /INSERT INTO busrules/.test(x.sql))).toHaveLength(50);
  });

  it('10 simultaneous saves all finish and each one uses its own transaction', async () => {
    const { svc, ds } = build();
    await Promise.all(Array.from({ length: 10 }, (_, i) => svc.updateBusinessRules({ ...FULL, RULE_LOAN_R_RATE: i + 1 })));
    expect(ds.createQueryRunner).toHaveBeenCalledTimes(10);
  });
});
