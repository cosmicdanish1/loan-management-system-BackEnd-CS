import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { DemandImportService } from '../../../src/modules/transaction/services-v2/demand-import.service';

const HEADER = ['S.NO.', 'YYMM', 'CODE', 'MS.NO.', 'PS.NO.', 'NAME', 'TOTAL', 'R/D', 'R/LOAN', 'E/LOAN', 'INTT'];

const workbook = (rows: any[][], sheetName = 'APR', extraSheets: string[] = []) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), sheetName);
  for (const name of extraSheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, [1, '', '', '2002', '', 'Other', 0, 0, 0, 0, 0]]), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};

const build = (opts: { members?: any[]; existing?: boolean; failOn?: string } = {}) => {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const members = opts.members ?? [{ mbno: 1001, officeno: '1', dept_name: 'Ops', name: 'Asha Patil' }];
  const qr: any = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (opts.failOn && sql.includes(opts.failOn)) throw new Error('db down');
      if (sql.includes('LOCK TABLE')) return [];
      if (sql.includes('MAX(dmnd_srno)')) return [{ next_serial: '9' }];
      if (sql.includes('SELECT officeno FROM member_master')) {
        const m = members.find((x) => String(x.mbno) === String(params?.[0]));
        return m ? [{ officeno: m.officeno }] : [];
      }
      if (sql.includes('UPDATE demand_master SET')) return opts.existing ? [[{ mbno: params?.[9] }], 1] : [[], 0];
      if (sql.includes('FROM yearend')) return [{ yearcode: 2026 }];
      if (sql.includes('FROM rd_member_config')) return [{ monthly_rd_amount: '10' }];
      if (sql.includes('FROM loan_master')) return [];
      if (sql.includes('FROM system_configs')) return [];
      return [];
    }),
  };
  const dataSource: any = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes('FROM member_master WHERE CAST(mbno AS text)')) {
        const wanted = params?.[0] ?? [];
        return members.filter((m) => wanted.includes(String(m.mbno)));
      }
      return [];
    }),
    createQueryRunner: jest.fn().mockReturnValue(qr),
  };
  const service = new DemandImportService(dataSource);
  return { service, qr, dataSource, calls };
};

const previewRow = (over: Partial<Record<string, any>> = {}) => ({
  key: '0-1001', memberId: '1001', memberName: 'Asha', department: 'Ops',
  rlnAmount: 100, alnAmount: 0, rdAmount: 10, interest: 20, totalDemand: 130, fileTotal: 130,
  status: 'Valid' as const, remarks: '', ...over,
});

describe('DemandImportService preview', () => {
  it('maps the file columns and keeps R/D separate from the loan columns', async () => {
    const { service } = build();
    const result = await service.previewFromBuffer(workbook([[1, '2604', 'C1', '1001', 'PS1', 'Asha', 130, 10, 100, 0, 20]]));

    expect(result).toMatchObject({ sheetName: 'APR', totalRows: 1, validCount: 1, errorCount: 0 });
    expect(result.rows[0]).toMatchObject({
      memberId: '1001', memberName: 'Asha Patil', department: 'Ops',
      rlnAmount: 100, alnAmount: 0, rdAmount: 10, interest: 20, totalDemand: 130, status: 'Valid',
    });
  });

  it('treats E/LOAN as the emergency (ALN) column', async () => {
    const { service } = build();
    const result = await service.previewFromBuffer(workbook([[1, '2604', 'C1', '1001', 'PS1', 'Asha', 130, 10, 0, 100, 20]]));
    expect(result.rows[0]).toMatchObject({ alnAmount: 100, rlnAmount: 0 });
  });

  it('flags a member that does not exist', async () => {
    const { service } = build();
    const result = await service.previewFromBuffer(workbook([[1, '2604', 'C1', '9999', 'PS1', 'Ghost', 130, 10, 100, 0, 20]]));
    expect(result.rows[0]).toMatchObject({ status: 'Error' });
    expect(result.rows[0].remarks).toContain('not found');
  });

  it('flags a duplicate member in the same file', async () => {
    const { service } = build();
    const result = await service.previewFromBuffer(workbook([
      [1, '2604', 'C1', '1001', 'PS1', 'Asha', 130, 10, 100, 0, 20],
      [2, '2604', 'C1', '1001', 'PS1', 'Asha', 130, 10, 100, 0, 20],
    ]));
    expect(result.rows[1].status).toBe('Error');
    expect(result.rows[1].remarks).toContain('Duplicate member');
  });

  it('flags a row whose components do not add up to the file total', async () => {
    const { service } = build();
    const result = await service.previewFromBuffer(workbook([[1, '2604', 'C1', '1001', 'PS1', 'Asha', 500, 10, 100, 0, 20]]));
    expect(result.rows[0].status).toBe('Error');
    expect(result.rows[0].remarks).toContain("doesn't match");
  });

  it('keeps the preview and the save tolerance consistent', async () => {
    const { service, qr } = build();
    // Half a rupee off: preview currently accepts it, but saveRows silently skips it.
    const result = await service.previewFromBuffer(workbook([[1, '2604', 'C1', '1001', 'PS1', 'Asha', 130.5, 10, 100, 0, 20]]));
    expect(result.rows[0].status).toBe('Error');

    const saved = await service.saveRows(4, 2026, [previewRow({ totalDemand: 130.5, fileTotal: 130.5 })]);
    expect(saved.saved).toBe(0);
    expect(qr.commitTransaction).toHaveBeenCalled();
  });

  it('flags a member from another branch', async () => {
    const { service } = build();
    const result = await service.previewFromBuffer(
      workbook([[1, '2604', 'C1', '1001', 'PS1', 'Asha', 130, 10, 100, 0, 20]]), '2',
    );
    expect(result.rows[0].status).toBe('Error');
    expect(result.rows[0].remarks).toContain('not 2');
  });

  it('selects the sheet that names the branch and reports every sheet', async () => {
    const { service } = build();
    const result = await service.previewFromBuffer(workbook([[1, '2604', 'C1', '1001', 'PS1', 'Asha', 130, 10, 100, 0, 20]], 'MAY', ['APR']), 'APR');
    expect(result.sheetName).toBe('APR');
    expect(result.availableSheets).toEqual(['MAY', 'APR']);
  });

  it('rejects a sheet without the member-number column', async () => {
    const { service } = build();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['NAME', 'TOTAL'], ['Asha', 10]]), 'APR');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    await expect(service.previewFromBuffer(buffer)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a sheet with no data rows', async () => {
    const { service } = build();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER]), 'APR');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    await expect(service.previewFromBuffer(buffer)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('flags a negative amount', async () => {
    const { service } = build();
    const result = await service.previewFromBuffer(workbook([[1, '2604', 'C1', '1001', 'PS1', 'Asha', 130, 10, -100, 0, 20]]));
    expect(result.rows[0].status).toBe('Error');
    expect(result.rows[0].remarks).toContain('non-negative');
  });
});

describe('DemandImportService save', () => {
  it('writes a new demand row and its RD installment', async () => {
    const { service, calls } = build({ existing: false });

    const result = await service.saveRows(4, 2026, [previewRow()], '1');

    expect(result).toMatchObject({ saved: 1, skipped: 0, flagged: 0 });
    const insert = calls.find(({ sql }) => sql.includes('INSERT INTO demand_master'));
    expect(insert?.params).toEqual([4, 2026, '1001', '1', 9, 100, 20, 0, 0, 10, 130]);
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO rd_installment_ledger'))).toBe(true);
  });

  it('updates an existing demand row instead of inserting a duplicate', async () => {
    const { service, calls } = build({ existing: true });
    await service.saveRows(4, 2026, [previewRow()], '1');
    expect(calls.some(({ sql }) => sql.includes('UPDATE demand_master SET'))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO demand_master'))).toBe(false);
  });

  it('skips invalid, duplicate, branch-mismatched and tampered rows', async () => {
    const { service } = build({ existing: true });

    const result = await service.saveRows(4, 2026, [
      previewRow({ key: 'a', status: 'Error' }),
      previewRow({ key: 'b' }),
      previewRow({ key: 'c' }),
      previewRow({ key: 'd', memberId: '1002' }),
      previewRow({ key: 'e', totalDemand: 999 }),
    ], '1');

    // b saves, c is the duplicate of b, d is unknown, e has a mismatched total
    expect(result).toMatchObject({ saved: 1, skipped: 4 });
  });

  it('does not record an RD installment when the R/D column is zero', async () => {
    const { service, calls } = build({ existing: true });
    await service.saveRows(4, 2026, [previewRow({ rdAmount: 0, totalDemand: 120, fileTotal: 120 })], '1');
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO rd_installment_ledger'))).toBe(false);
  });

  it('rolls back and wraps a write failure', async () => {
    const { service, qr } = build({ failOn: 'INSERT INTO demand_master' });
    await expect(service.saveRows(4, 2026, [previewRow()], '1')).rejects.toThrow(/Failed to save imported demand/);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });
});
