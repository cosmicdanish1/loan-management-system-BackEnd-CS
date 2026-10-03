import { BadRequestException } from '@nestjs/common';
import { PrintVoucherService } from '../../src/modules/print-voucher/print-voucher.service';

const makeQuery = (result: unknown[]) => {
  const query: any = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(result),
    getRawMany: jest.fn().mockResolvedValue(result),
  };
  return query;
};

describe('PrintVoucherService', () => {
  it.each([
    ['P', 'Payment'], ['DR', 'Payment'], ['R', 'Receipt'], ['CR', 'Receipt'],
  ])('classifies legacy and normalized direction %s as %s', async (type, expected) => {
    const voucherQuery = makeQuery([{
      trans_no: 1, trans_date: new Date('2026-09-01T10:00:00'), trans_type: type,
      trans_amt: '125.50', receipt_vchr_no: 'V100', vchr_type: 'PV', modeofpay: 'C',
      mbno: 0, code: 'A1001', narration: 'sample',
    }]);
    const service = new PrintVoucherService(
      { createQueryBuilder: jest.fn().mockReturnValue(voucherQuery) } as any,
      { findOne: jest.fn().mockResolvedValue({ head_name: 'Cash' }) } as any,
      { findOne: jest.fn() } as any,
      { find: jest.fn() } as any,
    );

    const voucher = await service.getVoucherByNo('V100');
    expect(voucher.dr_cr).toBe(expected);
    expect(voucher.entries[0].direction).toBe(expected);
    expect(voucher.entries[0].amount).toBe(125.5);
    expect(voucher.total_amount).toBe(125.5);
    expect(voucherQuery.andWhere).toHaveBeenCalledWith(expect.stringContaining("NOT IN ('JV', 'J')"));
  });

  it('includes every journal transaction leg, including rows without a member, and maps P/R sides', async () => {
    const entries = [
      { trans_no: 1, trans_date: new Date('2026-09-01'), trans_type: 'P', trans_amt: '300', mbno: 101, code: 'A1001', narration: 'debit' },
      { trans_no: 2, trans_date: new Date('2026-09-01'), trans_type: 'R', trans_amt: '300', mbno: null, code: 'L1001', narration: 'credit' },
    ];
    const query: any = {
      where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(entries),
    };
    const transactions = { createQueryBuilder: jest.fn().mockReturnValue(query) };
    const members = { findOne: jest.fn().mockResolvedValue({ fullName: 'Test Member' }) };
    const heads = { findOne: jest.fn(({ where }: any) => Promise.resolve({ head_name: where.code })) };
    const service = new PrintVoucherService(transactions as any, heads as any, members as any, { find: jest.fn() } as any);

    const voucher = await service.getJournalVoucherByNo('J100');
    expect(query.where).toHaveBeenCalledWith('transaction.receipt_vchr_no = :voucherNo', { voucherNo: 'J100' });
    expect(query.andWhere).toHaveBeenCalledWith("transaction.vchr_type IN ('JV', 'J')");
    expect(voucher.entries).toHaveLength(2);
    expect(voucher.entries.map(entry => [entry.debit, entry.credit])).toEqual([[300, 0], [0, 300]]);
    expect(voucher.entries[1].member_code).toBe('');
    expect(voucher.entries[1].member_name).toBe('');
  });

  it('rejects unknown directions rather than silently reporting them as receipts', async () => {
    const voucherQuery = makeQuery([{
      trans_no: 1, trans_date: new Date(), trans_type: 'XX', trans_amt: '10',
      receipt_vchr_no: 'V200', vchr_type: 'RV', mbno: 0, code: 'A1001',
    }]);
    const service = new PrintVoucherService(
      { createQueryBuilder: jest.fn().mockReturnValue(voucherQuery) } as any,
      {} as any, {} as any, {} as any,
    );

    await expect(service.getVoucherByNo('V200')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('scopes repeated voucher numbers to the selected calendar date', async () => {
    const voucherQuery = makeQuery([{
      trans_no: 4, trans_date: new Date('2026-09-01T10:00:00'), trans_type: 'P',
      trans_amt: '15', receipt_vchr_no: 'V100', vchr_type: 'PV', mbno: 0, code: 'A1001',
    }]);
    const service = new PrintVoucherService(
      { createQueryBuilder: jest.fn().mockReturnValue(voucherQuery) } as any,
      { findOne: jest.fn().mockResolvedValue({ head_name: 'Cash' }) } as any,
      {} as any, {} as any,
    );

    await service.getVoucherByNo('V100', '2026-09-01');
    expect(voucherQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining("transaction.trans_date >= CAST(:voucherDate AS date)"),
      { voucherDate: '2026-09-01' },
    );
  });
});
