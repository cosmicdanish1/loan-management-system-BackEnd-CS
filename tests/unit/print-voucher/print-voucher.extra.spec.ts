import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrintVoucherService } from '../../../src/modules/print-voucher/print-voucher.service';

const q = (opts: { data?: any[]; raw?: any } = {}) => {
  const query: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(opts.data ?? []),
    getRawMany: jest.fn().mockResolvedValue(opts.raw ?? []),
  };
  return query;
};

const build = (opts: { transactions?: any[]; ledger?: any[]; heads?: any; members?: any } = {}) => {
  const tq = q({ data: opts.transactions ?? [] });
  const lq = q({ data: opts.ledger ?? [] });
  const transactions: any = {
    createQueryBuilder: jest.fn().mockReturnValue(tq),
  };
  const ledger: any = { createQueryBuilder: jest.fn().mockReturnValue(lq) };
  const heads: any = {
    findOne: opts.heads ?? jest.fn(({ where }: any) => Promise.resolve({ head_name: `Head ${where.code}` })),
  };
  const members: any = opts.members ?? {
    findOne: jest.fn().mockResolvedValue({ fullName: 'Asha Patil' }),
  };
  const service = new PrintVoucherService(transactions, heads, members, ledger);
  return { service, tq, lq, transactions, ledger, heads, members };
};

describe('PrintVoucherService extra cases', () => {
  it('parses currency-formatted amounts and maps the payment mode', async () => {
    const { service } = build({
      transactions: [{
        trans_no: 1, trans_date: new Date('2026-09-01T00:00:00Z'), trans_type: 'P',
        trans_amt: '₹1,234.50', receipt_vchr_no: 'V1', vchr_type: 'PV', modeofpay: 'q',
        cheq_no: 'CHQ1', cheq_date: new Date('2026-09-01'), bankname: 'SBI', mbno: 0, code: 'A1001',
      }],
    });

    const voucher = await service.getVoucherByNo('V1');
    expect(voucher.entries[0].amount).toBe(1234.5);
    expect(voucher.total_amount).toBe(1234.5);
    expect(voucher.mode).toBe('Cheque');
    expect(voucher.cheque_no).toBe('CHQ1');
    expect(voucher.bank_name).toBe('SBI');
  });

  it('reports Mixed when a voucher has both directions', async () => {
    const { service } = build({
      transactions: [
        { trans_no: 1, trans_date: new Date(), trans_type: 'P', trans_amt: '10', code: 'A1001' },
        { trans_no: 2, trans_date: new Date(), trans_type: 'R', trans_amt: '10', code: 'L1001' },
      ],
    });
    const voucher = await service.getVoucherByNo('V1');
    expect(voucher.dr_cr).toBe('Mixed');
    expect(voucher.entries.map((e) => e.direction)).toEqual(['Payment', 'Receipt']);
  });

  it('rejects a malformed voucher date before querying', async () => {
    const { service, tq } = build();
    await expect(service.getVoucherByNo('V1', '01-09-2026')).rejects.toBeInstanceOf(BadRequestException);
    expect(tq.getMany).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric amount instead of printing NaN', async () => {
    const { service } = build({
      transactions: [{ trans_no: 1, trans_date: new Date(), trans_type: 'P', trans_amt: 'abc', code: 'A1001' }],
    });
    await expect(service.getVoucherByNo('V1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown voucher number with 404', async () => {
    const { service } = build();
    await expect(service.getVoucherByNo('V404')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('falls back to legacy ledger rows for a journal voucher', async () => {
    const { service } = build({
      transactions: [],
      ledger: [
        { trans_no: 5, trans_date: new Date(), trans_type: 'R', trans_amt: '100', mbno: 0, code: 'L1001', narration: 'legacy' },
      ],
    });

    const voucher = await service.getJournalVoucherByNo('J1');
    expect(voucher.entries).toHaveLength(1);
    expect(voucher.entries[0]).toMatchObject({ credit: 100, debit: 0, member_code: '', member_name: '' });
  });

  it('merges transaction and legacy journal numbers, removes duplicates and sorts numerically', async () => {
    const tq = q({ raw: [{ voucher_no: 'J9' }, { voucher_no: 'J10' }] });
    const lq = q({ raw: [{ voucher_no: 'J10' }, { voucher_no: 'J2' }] });
    const transactions: any = { createQueryBuilder: jest.fn().mockReturnValue(tq) };
    const ledger: any = { createQueryBuilder: jest.fn().mockReturnValue(lq) };
    const service = new PrintVoucherService(transactions, {} as any, {} as any, ledger);

    await expect(service.getAllJournalVoucherNos()).resolves.toEqual(['J10', 'J9', 'J2']);
  });

  it('deduplicates journal references by voucher number and date', async () => {
    const tq = q({ raw: [{ voucher_no: 'J1', voucher_date: '2026-09-02' }, { voucher_no: 'J2', voucher_date: '2026-09-01' }] });
    const lq = q({ raw: [{ voucher_no: 'J1', voucher_date: '2026-09-02' }, { voucher_no: 'J3', voucher_date: '2026-08-31' }] });
    const transactions: any = { createQueryBuilder: jest.fn().mockReturnValue(tq) };
    const ledger: any = { createQueryBuilder: jest.fn().mockReturnValue(lq) };
    const service = new PrintVoucherService(transactions, {} as any, {} as any, ledger);

    await expect(service.getAllJournalVoucherReferences()).resolves.toEqual([
      { voucher_no: 'J1', voucher_date: '2026-09-02' },
      { voucher_no: 'J2', voucher_date: '2026-09-01' },
      { voucher_no: 'J3', voucher_date: '2026-08-31' },
    ]);
  });

  it('labels an unknown member instead of leaving the name blank', async () => {
    const { service } = build({
      transactions: [{ trans_no: 1, trans_date: new Date(), trans_type: 'P', trans_amt: '10', mbno: 1001, code: 'A1001' }],
      members: { findOne: jest.fn().mockResolvedValue(null) },
    });
    const voucher = await service.getVoucherByNo('V1');
    expect(voucher.member_name).toBe('Unknown Member');
  });
});
