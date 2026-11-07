import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VoucherService } from '../../../src/modules/transaction/services-v2/voucher.service';

const build = (opts: { heads?: string[]; deleteRows?: any[]; pendingRows?: any[] } = {}) => {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (/SELECT TRIM\(code\) AS code FROM headmaster/.test(sql)) {
        return (params?.[0] || []).filter((c: string) => (opts.heads ?? ['A001', 'A1001']).includes(c)).map((c: string) => ({ code: c }));
      }
      if (/SELECT COALESCE\(MAX\(/.test(sql)) return [{ next_id: '50' }];
      if (/FROM member_master/.test(sql)) return [{ mbno: params?.[0] }];
      if (/SELECT \* FROM vouchers WHERE "voucherNumber"/.test(sql)) return opts.deleteRows ?? [];
      if (/DELETE FROM/.test(sql)) return [undefined, 1];
      return [];
    }),
  };
  const dataSource: any = {
    createQueryRunner: jest.fn().mockReturnValue(qr),
    query: jest.fn(async (sql: string) => {
      calls.push({ sql, params: undefined });
      if (/SELECT COALESCE\(MAX\(/.test(sql)) return [{ next_id: '7' }];
      if (/FROM vouchers v/.test(sql)) return opts.pendingRows ?? [];
      return [];
    }),
  };
  const sequence: any = { getNextVoucherNumber: jest.fn().mockResolvedValue('R00009') };
  const notification: any = { sendManualNotification: jest.fn().mockResolvedValue(undefined) };
  const reagreement: any = {
    isReagreementCase: jest.fn().mockResolvedValue(false),
    createVoucher: jest.fn(),
    getById: jest.fn(),
    onVoucherRejected: jest.fn(),
  };
  const service = new VoucherService(dataSource, sequence, notification, reagreement);
  return { service, qr, dataSource, sequence, notification, reagreement, calls };
};

const entry = (over: Partial<Record<string, any>> = {}) => ({ amount: 100, debitAccount: 'A001', ...over });

describe('VoucherService createVoucher validation', () => {
  it('rejects an empty entry list', async () => {
    const { service, qr } = build();
    await expect(service.createVoucher({ voucherType: 'RECEIPT', transactions: [] })).rejects.toBeInstanceOf(BadRequestException);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });

  it('rejects a blank or non-numeric amount', async () => {
    const { service } = build();
    await expect(service.createVoucher({ voucherType: 'RECEIPT', transactions: [entry({ amount: '  ' })] })).rejects.toThrow(/amount must be a number/);
    await expect(service.createVoucher({ voucherType: 'RECEIPT', transactions: [entry({ amount: 'abc' })] })).rejects.toThrow(/amount must be a number/);
  });

  it('rejects a negative amount instead of creating a negative voucher', async () => {
    const { service } = build();
    await expect(service.createVoucher({ voucherType: 'RECEIPT', transactions: [entry({ amount: -100 })] }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown head code', async () => {
    const { service } = build({ heads: ['A001'] });
    await expect(service.createVoucher({ voucherType: 'RECEIPT', transactions: [entry({ debitAccount: 'ZZ999' })] }))
      .rejects.toThrow(/Unknown head code/);
  });

  it('requires a bank head when the payment method is not cash', async () => {
    const { service, qr } = build();
    await expect(service.createVoucher({
      voucherType: 'RECEIPT', paymentMethod: 'BANK', transactions: [entry()],
    })).rejects.toThrow(/bankCode/);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });

  it('allocates ids on the transactional connection, not the shared data source', async () => {
    const { service, dataSource } = build();
    await service.createVoucher({ voucherType: 'RECEIPT', paymentMethod: 'CASH', transactions: [entry()] });
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});

describe('VoucherService createVoucher staging', () => {
  it('stages a receipt with a DR cash leg and the right voucher flags', async () => {
    const { service, calls, notification } = build();

    const result = await service.createVoucher({
      voucherType: 'RECEIPT', paymentMethod: 'CASH', memberId: 1001,
      description: 'savings deposit', transactions: [entry({ amount: 250 })],
    });

    expect(result).toEqual({ success: true, message: 'Voucher created successfully', voucherNo: 'R00009' });

    const header = calls.find(({ sql }) => sql.includes('INSERT INTO vouchers'));
    expect(header?.params).toEqual(expect.arrayContaining([50, 'R00009', 'RECEIPT', 250, 1001])); // id from the voucher's own transaction (ES-413)
    expect(header?.params).toContain('PENDING'); // staged as pending, passed later

    const rows = calls.filter(({ sql }) => sql.includes('INSERT INTO transactions'));
    expect(rows).toHaveLength(2);
    expect(rows[0].params).toEqual(expect.arrayContaining(['R', 1001, 250, 'R00009', 'RV', 'C', 'N', 'A001']));
    expect(rows[1].params).toEqual(expect.arrayContaining(['DR', 1001, 250, 'R00009', 'RV']));
    expect(rows[1].params).toContain('A1001');
    expect(rows[1].params).toContain('CINH');

    // staged only: the member is not told before the voucher is passed (ES-413)
    expect(notification.sendManualNotification).not.toHaveBeenCalled();
  });

  it('stages a payment with a CR cash leg', async () => {
    const { service, calls } = build();

    await service.createVoucher({
      voucherType: 'PAYMENT', paymentMethod: 'CASH',
      transactions: [entry({ amount: 40, code: 'A001' })],
    });

    const rows = calls.filter(({ sql }) => sql.includes('INSERT INTO transactions'));
    expect(rows[0].params).toEqual(expect.arrayContaining(['P', 40, 'PV']));
    expect(rows[1].params).toEqual(expect.arrayContaining(['CR', 40, 'PV']));
  });

  it('debits the supplied bank head for a bank receipt', async () => {
    const { service, calls } = build({ heads: ['A001', 'B1001'] });
    await service.createVoucher({
      voucherType: 'RECEIPT', paymentMethod: 'BANK', bankCode: 'B1001',
      transactions: [entry()],
    });
    const rows = calls.filter(({ sql }) => sql.includes('INSERT INTO transactions'));
    expect(rows[1].params).toContain('B1001');
    expect(rows[1].params).toContain('BANK');
  });
});

describe('VoucherService deleteVoucher', () => {
  it('rejects an unknown voucher with 404', async () => {
    const { service } = build({ deleteRows: [] });
    await expect(service.deleteVoucher('V404')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to delete a voucher that is not PENDING', async () => {
    const { service, qr } = build({ deleteRows: [{ voucherNumber: 'V1', status: 'POSTED' }] });
    await expect(service.deleteVoucher('V1')).rejects.toThrow(/Only PENDING vouchers/);
    expect(qr.commitTransaction).not.toHaveBeenCalled();
  });

  it('deletes the staged rows and the header for a pending voucher', async () => {
    const { service, qr, calls } = build({ deleteRows: [{ voucherNumber: 'V1', status: 'PENDING' }] });
    await expect(service.deleteVoucher('V1')).resolves.toEqual({ success: true, message: 'Voucher V1 deleted successfully' });
    expect(calls.some(({ sql }) => sql.includes('DELETE FROM transactions'))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes('DELETE FROM vouchers'))).toBe(true);
    expect(qr.commitTransaction).toHaveBeenCalled();
  });
});

describe('VoucherService pending list', () => {
  it('maps a pending loan voucher and its staged breakdown', async () => {
    const { service, dataSource } = build({
      pendingRows: [{
        id: 1, voucherNumber: 'P00001', memberId: 1001, totalAmount: '500', voucherType: 'PAYMENT',
        remarks: 'LOAN_CASE:LC1|PAY_MODE:CASH', status: 'PENDING', description: 'loan', createdAt: new Date(),
        f_name: 'Asha', m_name: '', l_name: 'Patil', bankName: null, chequeNumber: null, sourceModule: null, sourceId: null,
      }],
    });
    dataSource.query.mockImplementation(async (sql: string) => {
      if (/FROM vouchers v/.test(sql)) {
        return [{
          id: 1, voucherNumber: 'P00001', memberId: 1001, totalAmount: '500', voucherType: 'PAYMENT',
          remarks: 'LOAN_CASE:LC1|PAY_MODE:CASH', status: 'PENDING', description: 'loan', createdAt: new Date(),
          f_name: 'Asha', m_name: '', l_name: 'Patil', bankName: null, chequeNumber: null, sourceModule: null, sourceId: null,
        }];
      }
      if (/SELECT loantype FROM loan_pending/.test(sql)) return [{ loantype: 'RLN' }];
      if (/SELECT \* FROM transactions/.test(sql)) return [{ code: 'A1002', narration: 'principal', trans_amt: '500' }];
      return [];
    });

    const [voucher] = await service.getPendingVouchers();
    expect(voucher).toMatchObject({
      voucherNo: 'P00001', memberName: 'Asha Patil', amount: 500,
      vchrType: 'PAYMENT', loanType: 'RLN', loanCaseNo: 'LC1', paymentMode: 'cash',
    });
    expect(voucher.breakdown).toEqual([{ srNo: '1', code: 'A1002', name: 'principal', rp: 'P', amount: 500 }]);
  });
});
