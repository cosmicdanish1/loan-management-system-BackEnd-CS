import { UtilitiesService } from '../../../src/modules/utilities/utilities.service';

// ES-591: the Modify Business Rules screen saves through UtilitiesService.updateBusinessRules, which stores only a fixed
// list of keys. The Import Demand strictness was not on that list, so the screen said "saved" and nothing was stored.
describe('UtilitiesService business rules: RULE_DEMAND_IMPORT_STRICTNESS (ES-591)', () => {
  const loanRules = {
    RULE_LOAN_R_MAX_AMT: 1000000, RULE_LOAN_R_RATE: 7, RULE_LOAN_R_INSTALLMENTS: 120, RULE_PENAL_RATE: 15, RULE_LOAN_R_GRACE_DAYS: 0,
    RULE_LOAN_ADD_MAX_AMT: 1000000, RULE_LOAN_ADD_RATE: 12, RULE_LOAN_ADD_INSTALLMENTS: 50, RULE_LOAN_ADD_PENAL_RATE: 2, RULE_LOAN_ADD_GRACE_DAYS: 0,
    RULE_LOAN_EMG_MAX_AMT: 300000, RULE_LOAN_EMG_RATE: 9, RULE_LOAN_EMG_INSTALLMENTS: 80, RULE_LOAN_EMG_PENAL_RATE: 2, RULE_LOAN_EMG_GRACE_DAYS: 0,
  };

  const build = (stored: Array<{ key: string; value: string; dataType: string }> = []) => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const qr: any = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
    };
    const ds: any = {
      createQueryRunner: jest.fn().mockReturnValue(qr),
      query: jest.fn(async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT CURRENT_DATE')) return [{ today: '2026-11-20' }];
        if (sql.includes('FROM system_configs WHERE key = ANY')) return stored;
        if (sql.startsWith('UPDATE system_configs')) return [[{ id: 1 }], 1]; // the row already exists
        return [];
      }),
    };
    return { svc: new UtilitiesService(ds, {} as any, {} as any), calls };
  };
  const strictnessWrite = (calls: Array<{ sql: string; params?: any[] }>) =>
    calls.find(({ sql, params }) => sql.startsWith('UPDATE system_configs') && params?.[2] === 'RULE_DEMAND_IMPORT_STRICTNESS');

  it('stores STANDARD when the screen sends it', async () => {
    const { svc, calls } = build();
    await svc.updateBusinessRules({ ...loanRules, RULE_DEMAND_IMPORT_STRICTNESS: 'STANDARD' });
    expect(strictnessWrite(calls)?.params).toEqual(['STANDARD', 'string', 'RULE_DEMAND_IMPORT_STRICTNESS']);
  });

  it('accepts the value in any case and with spaces', async () => {
    const { svc, calls } = build();
    await svc.updateBusinessRules({ ...loanRules, RULE_DEMAND_IMPORT_STRICTNESS: ' standard ' });
    expect(strictnessWrite(calls)?.params?.[0]).toBe('STANDARD');
  });

  it('stores anything else as STRICT, so a bad value can never loosen the import', async () => {
    for (const bad of ['banana', '', null, 5, 'LENIENT']) {
      const { svc, calls } = build();
      await svc.updateBusinessRules({ ...loanRules, RULE_DEMAND_IMPORT_STRICTNESS: bad as any });
      expect(strictnessWrite(calls)?.params?.[0]).toBe('STRICT');
    }
  });

  it('an older client that does not send it leaves the stored value alone', async () => {
    const { svc, calls } = build();
    await svc.updateBusinessRules({ ...loanRules });
    expect(strictnessWrite(calls)).toBeUndefined();
  });

  it('the rules screen gets the saved value back, and STRICT when it was never saved', async () => {
    const saved = await (build([{ key: 'RULE_DEMAND_IMPORT_STRICTNESS', value: 'STANDARD', dataType: 'string' }]).svc as any).fetchSystemConfigRules();
    expect(saved.RULE_DEMAND_IMPORT_STRICTNESS).toBe('STANDARD');
    const never = await (build([]).svc as any).fetchSystemConfigRules();
    expect(never.RULE_DEMAND_IMPORT_STRICTNESS).toBe('STRICT');
  });

  it('the key is among the keys that are read back from system_configs', async () => {
    const { svc, calls } = build();
    await (svc as any).fetchSystemConfigRules();
    const read = calls.find(({ sql }) => sql.includes('FROM system_configs WHERE key = ANY'));
    expect(read?.params?.[0]).toContain('RULE_DEMAND_IMPORT_STRICTNESS');
  });
});
