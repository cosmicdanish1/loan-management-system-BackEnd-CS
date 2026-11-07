import {
  WidenVoucherNumberColumns1791590400000,
  VOUCHER_NUMBER_COLUMNS,
  VOUCHER_NUMBER_WIDTH,
} from '../../../src/migrations/1791590400000-WidenVoucherNumberColumns';

// ES-494: voucher numbers (VCH1000 is 7 characters) must fit every column that stores them
describe('migrations/WidenVoucherNumberColumns (ES-494)', () => {
  const build = (state: Record<string, { type: string; len: number | null } | undefined>) => {
    const alters: string[] = [];
    const queryRunner: any = {
      query: jest.fn(async (sql: string, params?: any[]) => {
        if (/information_schema\.columns/.test(sql)) {
          const found = state[`${params![0]}.${params![1]}`];
          return found ? [{ data_type: found.type, character_maximum_length: found.len }] : [];
        }
        alters.push(sql);
        return [];
      }),
    };
    return { queryRunner, alters };
  };
  const all = (len: number | null, type = 'character varying') =>
    Object.fromEntries(VOUCHER_NUMBER_COLUMNS.map(([t, c]) => [`${t}.${c}`, { type, len }]));

  it('widens every short voucher number column to varchar(20)', async () => {
    const { queryRunner, alters } = build(all(6));
    await new WidenVoucherNumberColumns1791590400000().up(queryRunner);
    expect(alters).toHaveLength(VOUCHER_NUMBER_COLUMNS.length);
    expect(alters.every((s) => s.includes(`TYPE varchar(${VOUCHER_NUMBER_WIDTH})`))).toBe(true);
    expect(alters.some((s) => s.includes('"ledger" ALTER COLUMN "receipt_vchr_no"'))).toBe(true);
    expect(alters.some((s) => s.includes('"transactions" ALTER COLUMN "receipt_vchr_no"'))).toBe(true);
  });
  it('is idempotent: columns that are already wide are left alone', async () => {
    const { queryRunner, alters } = build(all(20));
    await new WidenVoucherNumberColumns1791590400000().up(queryRunner);
    expect(alters).toHaveLength(0);
  });
  it('never narrows a column that is wider than 20', async () => {
    const { queryRunner, alters } = build(all(50));
    await new WidenVoucherNumberColumns1791590400000().up(queryRunner);
    expect(alters).toHaveLength(0);
  });
  it('skips tables or columns that do not exist in this database', async () => {
    const { queryRunner, alters } = build({});
    await new WidenVoucherNumberColumns1791590400000().up(queryRunner);
    expect(alters).toHaveLength(0);
  });
  it('skips columns that are not text (never rewrites a numeric column)', async () => {
    const { queryRunner, alters } = build(all(null, 'numeric'));
    await new WidenVoucherNumberColumns1791590400000().up(queryRunner);
    expect(alters).toHaveLength(0);
  });
  it('the ledger and transactions voucher columns are in the list (the ones that failed at VCH1000)', () => {
    const names = VOUCHER_NUMBER_COLUMNS.map(([t, c]) => `${t}.${c}`);
    expect(names).toEqual(expect.arrayContaining(['ledger.receipt_vchr_no', 'transactions.receipt_vchr_no']));
  });
  it('VCH1000 fits the new width', () => expect('VCH1000'.length).toBeLessThanOrEqual(VOUCHER_NUMBER_WIDTH));
});
