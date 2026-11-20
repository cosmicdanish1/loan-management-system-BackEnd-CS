import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { DemandImportService } from '../../../src/modules/transaction/services-v2/demand-import.service';

// the layout the importer documented first (full member number, R/D)
const HEADER = ['S.NO.', 'YYMM', 'CODE', 'MS.NO.', 'PS.NO.', 'NAME', 'TOTAL', 'R/D', 'R/LOAN', 'E/LOAN', 'INTT'];
// the layout of the real payroll file ("NANDINI OCT IN NOV 202611.xlsx", ES-586)
const PAYROLL_HEADER = ['YYMM', 'CODE', 'H.O.NO.', 'PS.NO.', 'NAME', 'TOTAL', 'F/D', 'R/LOAN', 'E/LOAN', 'INTT.', 'F.R.S.-1', 'F.R.S.-2'];

const workbook = (rows: any[][], sheetName = 'APR', extraSheets: string[] = [], header: string[] = HEADER) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), sheetName);
  for (const name of extraSheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, [1, '', '', '2002', '', 'Other', 0, 0, 0, 0, 0]]), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};
const payroll = (rows: any[][]) => workbook(rows, 'NANDINI', [], PAYROLL_HEADER);

const STRICT_KEY = "RULE_DEMAND_IMPORT_STRICTNESS";

// strictness: what the Business Rule says. Default STANDARD here so the older save tests keep their meaning; the real default (rule missing) is STRICT.
const build = (opts: { members?: any[]; existing?: boolean; posted?: boolean; failOn?: string; noConfig?: boolean; strictness?: "STRICT" | "STANDARD" | "MISSING" | "BROKEN" } = {}) => {
  const strictness = opts.strictness ?? "STANDARD";
  const strictnessRows = (): any[] => {
    if (strictness === "BROKEN") throw new Error("config table missing");
    return strictness === "MISSING" ? [] : [{ value: strictness === "STRICT" ? "strict" : "Standard" }];
  };
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const members = opts.members ?? [{ mbno: 1001, officeno: '1', dept_name: 'Ops', name: 'Asha Patil', pfno: 'PS1' }];
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
      if (sql.includes('FROM system_configs') && params?.[0] === STRICT_KEY) return strictnessRows();
      // the server finds the member again (STRICT)
      if (sql.includes('CAST(mbno AS numeric) %')) {
        const pow = Number(params?.[0]);
        return members.filter((m) => Number(m.mbno) % pow === Number(params?.[1]));
      }
      if (sql.includes('SELECT mbno, officeno, pfno') && sql.includes('CAST(mbno AS text) = $1')) {
        return members.filter((m) => String(m.mbno) === String(params?.[0]));
      }
      if (sql.includes('SELECT officeno FROM member_master')) {
        const m = members.find((x) => String(x.mbno) === String(params?.[0]));
        return m ? [{ officeno: m.officeno }] : [];
      }
      if (sql.includes("AND demand_posted = 'Y'")) return opts.posted ? [{ '?column?': 1 }] : [];
      if (sql.includes('UPDATE demand_master SET')) return opts.existing ? [[{ mbno: params?.[11] }], 1] : [[], 0];
      if (sql.includes('FROM yearend')) return [{ yearcode: 2026 }];
      if (sql.includes('FROM rd_member_config')) return opts.noConfig ? [] : [{ monthly_rd_amount: '10' }];
      if (sql.includes('FROM loan_master')) return [];
      if (sql.includes('FROM system_configs')) return [];
      return [];
    }),
  };
  const dataSource: any = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes('FROM system_configs') && params?.[0] === STRICT_KEY) return strictnessRows();
      if (sql.includes('FROM member_master WHERE CAST(mbno AS text)')) {
        const wanted = params?.[0] ?? [];
        return members.filter((m) => wanted.includes(String(m.mbno)));
      }
      // H.O.NO. lookup: members whose last digits equal one of the numbers
      if (sql.includes('CAST(mbno AS numeric) %')) {
        const pow = Number(params?.[0]);
        const tails = (params?.[1] ?? []).map(Number);
        return members.filter((m) => tails.includes(Number(m.mbno) % pow));
      }
      // name suggestions
      if (sql.includes('LIKE ANY($1')) {
        const words: string[] = (params?.[0] ?? []).map((p: string) => p.slice(1, -1));
        const score = (m: any) => words.filter((w) => String(m.name).toUpperCase().includes(w)).length;
        return members.filter((m) => score(m) > 0).sort((a, b) => score(b) - score(a)).slice(0, 5);
      }
      return [];
    }),
    createQueryRunner: jest.fn().mockReturnValue(qr),
  };
  const service = new DemandImportService(dataSource);
  return { service, qr, dataSource, calls };
};

const previewRow = (over: Partial<Record<string, any>> = {}) => ({
  key: '2-1001', rowNo: 2, memberId: '1001', memberNoGiven: '1001', nameInFile: 'Asha', psNo: 'PS1', memberName: 'Asha', department: 'Ops',
  rlnAmount: 100, alnAmount: 0, cdAmount: 10, mdAmount: 0, md1Amount: 0, interest: 20, totalDemand: 130, fileTotal: 130,
  status: 'Valid' as const, remarks: '', matchMethod: 'MEMBER_NO' as const, ...over,
});

describe('DemandImportService preview', () => {
  it('maps the file columns and keeps the RD/CD amount separate from the loan columns', async () => {
    const { service } = build();
    const result = await service.previewFromBuffer(workbook([[1, '2604', 'C1', '1001', 'PS1', 'Asha', 130, 10, 100, 0, 20]]));

    expect(result).toMatchObject({ sheetName: 'APR', totalRows: 1, validCount: 1, errorCount: 0 });
    expect(result.rows[0]).toMatchObject({
      memberId: '1001', memberName: 'Asha Patil', department: 'Ops', matchMethod: 'MEMBER_NO',
      rlnAmount: 100, alnAmount: 0, cdAmount: 10, mdAmount: 0, md1Amount: 0, interest: 20, totalDemand: 130, status: 'Valid',
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

  it('rejects a sheet without a member column and names both accepted headers', async () => {
    const { service } = build();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['NAME', 'TOTAL'], ['Asha', 10]]), 'APR');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    await expect(service.previewFromBuffer(buffer)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.previewFromBuffer(buffer)).rejects.toThrow(/H\.O\.NO\.|MS\.NO\./);
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

describe('ES-586: the real payroll file header (H.O.NO., F/D, F.R.S.-1, F.R.S.-2)', () => {
  const members = [
    { mbno: 130023132, officeno: 4, dept_name: 'Ops', name: 'SHIV KUMAR NISHAD', pfno: '230425' },
    { mbno: 130028423, officeno: 4, dept_name: 'Ops', name: 'MAHESH CHANDRA KATARE', pfno: '230572' },
  ];

  it('reads F/D as the RD/CD amount, F.R.S.-1 as MD and F.R.S.-2 as MD1, and the total includes them', async () => {
    const { service } = build({ members });
    // row 1 of the real file: 225 = 200 + 8 + 17; row 2: 15227 = 500 + 11904 + 2798 + 8 + 17
    const result = await service.previewFromBuffer(payroll([
      [202610, 'COPN013', 23132, 230425, 'SHIV KUMAR NISHAD     ', 225, 200, '', '', '', 8, 17],
      [202610, 'COPN013', 28423, 230572, 'MAHESH CHANDRA KATARE', 15227, 500, '', 11904, 2798, 8, 17],
    ]));
    expect(result).toMatchObject({ totalRows: 2, validCount: 2, errorCount: 0 });
    expect(result.rows[0]).toMatchObject({ memberId: '130023132', cdAmount: 200, mdAmount: 8, md1Amount: 17, rlnAmount: 0, alnAmount: 0, interest: 0, totalDemand: 225, status: 'Valid' });
    expect(result.rows[1]).toMatchObject({ memberId: '130028423', cdAmount: 500, alnAmount: 11904, interest: 2798, mdAmount: 8, md1Amount: 17, totalDemand: 15227, status: 'Valid' });
  });

  it('accepts the old and the new header names for the same fields', async () => {
    const { service } = build();
    const header = ['MS.NO.', 'NAME', 'TOTAL', 'RD/CD', 'MD', 'MD1'];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ['1001', 'Asha', 130, 100, 20, 10]]), 'APR');
    const result = await service.previewFromBuffer(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    expect(result.rows[0]).toMatchObject({ cdAmount: 100, mdAmount: 20, md1Amount: 10, status: 'Valid' });
  });

  it('a row whose TOTAL ignores F.R.S.-1 / F.R.S.-2 is flagged, not silently saved', async () => {
    const { service } = build({ members });
    const result = await service.previewFromBuffer(payroll([[202610, 'COPN013', 23132, 230425, 'SHIV KUMAR NISHAD', 200, 200, '', '', '', 8, 17]]));
    expect(result.rows[0].status).toBe('Error');
    expect(result.rows[0].remarks).toContain("doesn't match");
  });

  it('records how each member was found', async () => {
    const { service } = build({ members });
    const result = await service.previewFromBuffer(payroll([[202610, 'COPN013', 23132, 230425, 'SHIV KUMAR NISHAD', 225, 200, '', '', '', 8, 17]]));
    expect(result.matchedBy).toEqual({ MEMBER_NO: 0, HONO: 1 });
    expect(result.rows[0]).toMatchObject({ matchMethod: 'HONO', honoGiven: '23132', psNo: '230425', rowNo: 2 });
  });

  it('warns (never blocks) when the file month differs from the selected month', async () => {
    const { service } = build({ members });
    const buf = payroll([[202610, 'COPN013', 23132, 230425, 'SHIV KUMAR NISHAD', 225, 200, '', '', '', 8, 17]]);
    const other = await service.previewFromBuffer(buf, undefined, 11, 2026);
    expect(other.warnings).toHaveLength(1);
    expect(other.warnings[0]).toContain('2026-10');
    expect(other.rows[0].status).toBe('Valid');
    const same = await service.previewFromBuffer(buf, undefined, 10, 2026);
    expect(same.warnings).toEqual([]);
  });
});

describe('ES-587: finding the member from H.O.NO.', () => {
  const row = (hono: any, ps: any, name: string, code = 'COPN013') => [202610, code, hono, ps, name, 225, 200, '', '', '', 8, 17];

  it('uses the prefix at the end of CODE when the same last digits belong to members of different prefixes', async () => {
    const { service } = build({
      members: [
        { mbno: 130023132, officeno: 4, name: 'SHIV KUMAR NISHAD', pfno: '230425' },
        { mbno: 610023132, officeno: 4, name: 'OTHER PERSON', pfno: '999' },
      ],
    });
    const result = await service.previewFromBuffer(payroll([row(23132, '', 'X')]));
    expect(result.rows[0]).toMatchObject({ memberId: '130023132', status: 'Valid' });
  });

  it('never picks silently when it is still ambiguous', async () => {
    const { service } = build({
      members: [
        { mbno: 130023132, officeno: 4, name: 'ONE', pfno: '1' },
        { mbno: 130123132, officeno: 5, name: 'TWO', pfno: '2' },
      ],
    });
    // both members end in ...23132 and start with 13 (the 7-digit tails differ but H.O.NO. has 5 digits)
    const result = await service.previewFromBuffer(payroll([row(23132, '', 'UNKNOWN')]));
    expect(result.rows[0].status).toBe('Error');
    expect(result.rows[0].remarks).toContain('fits 2 members');
  });

  it('uses the office, then PS.NO., then the name to choose between candidates, only when exactly one fits', async () => {
    const members = [
      { mbno: 130023132, officeno: 4, name: 'ONE', pfno: '111' },
      { mbno: 130123132, officeno: 5, name: 'TWO', pfno: '222' },
    ];
    const byOffice = await build({ members }).service.previewFromBuffer(payroll([row(23132, '', 'X')]), '5');
    expect(byOffice.rows[0]).toMatchObject({ memberId: '130123132' });
    const byPs = await build({ members }).service.previewFromBuffer(payroll([row(23132, '222', 'X')]));
    expect(byPs.rows[0]).toMatchObject({ memberId: '130123132' });
    const byName = await build({ members }).service.previewFromBuffer(payroll([row(23132, '', 'one')]));
    expect(byName.rows[0]).toMatchObject({ memberId: '130023132' });
  });

  it('an unknown H.O.NO. is an Error with name suggestions, and nothing is chosen for the operator', async () => {
    const { service } = build({ members: [{ mbno: 130023132, officeno: 4, name: 'SHIV KUMAR NISHAD', pfno: '230425' }] });
    const result = await service.previewFromBuffer(payroll([row(99999, '230425', 'SHIV KUMAR NISHAD')]));
    expect(result.rows[0].status).toBe('Error');
    expect(result.rows[0].memberId).toBe('');
    expect(result.rows[0].remarks).toContain('No member found for H.O.NO. 99999');
    expect(result.rows[0].suggestions).toEqual([{ memberNo: '130023132', name: 'SHIV KUMAR NISHAD', officeno: '4' }]);
    expect(result.rows[0].matchMethod).toBeUndefined();
  });

  it('a different name or PS.NO. is only a warning on the row', async () => {
    const { service } = build({ members: [{ mbno: 130023132, officeno: 4, name: 'SHIV KUMAR NISHAD', pfno: '230425' }] });
    const result = await service.previewFromBuffer(payroll([row(23132, '777', 'COMPLETELY DIFFERENT')]));
    expect(result.rows[0].status).toBe('Valid');
    expect(result.rows[0].warnings).toHaveLength(2);
    expect(result.rows[0].warnings!.join(' ')).toContain('Name in file');
    expect(result.rows[0].warnings!.join(' ')).toContain('PS.NO.');
  });

  it('a shorter name that is part of the member name raises no warning', async () => {
    const { service } = build({ members: [{ mbno: 130023132, officeno: 4, name: 'SHIV KUMAR NISHAD', pfno: '230425' }] });
    const result = await service.previewFromBuffer(payroll([row(23132, '230425', 'SHIV KUMAR')]));
    expect(result.rows[0].warnings).toBeUndefined();
  });

  it('tells the operator when the member has no PS.NO. on record but the file has one', async () => {
    const { service } = build({ members: [{ mbno: 130023132, officeno: 4, name: 'SHIV KUMAR NISHAD', pfno: '' }] });
    const result = await service.previewFromBuffer(payroll([row(23132, '230425', 'SHIV KUMAR NISHAD')]));
    expect(result.rows[0].status).toBe('Valid');
    expect(result.rows[0].warnings![0]).toContain('no PS.NO. on record');
  });

  it('two file rows that resolve to the same member are a duplicate', async () => {
    const { service } = build({ members: [{ mbno: 130023132, officeno: 4, name: 'SHIV KUMAR NISHAD', pfno: '230425' }] });
    const result = await service.previewFromBuffer(payroll([row(23132, '230425', 'SHIV'), row(23132, '230425', 'SHIV')]));
    expect(result.rows[1].status).toBe('Error');
    expect(result.rows[1].remarks).toContain('Duplicate member');
  });

  it('never accepts a member of another prefix just because the last digits fit', async () => {
    // 99999 exists only for a member whose number starts with 61, but the CODE says 13
    const { service } = build({ members: [{ mbno: 610099999, officeno: 1, name: 'DIFF ACCOUNT', pfno: '' }] });
    const result = await service.previewFromBuffer(payroll([row(99999, '', 'SHIV KUMAR NISHAD')]));
    expect(result.rows[0].status).toBe('Error');
    expect(result.rows[0].memberId).toBe('');
    expect(result.rows[0].remarks).toContain('starts with 13');
  });

  it('suggestions come best match first (the same name before a name that shares one word)', async () => {
    const { service } = build({
      members: [
        { mbno: 130020001, officeno: 4, name: 'ASHOK KUMAR', pfno: '' },
        { mbno: 130028441, officeno: 4, name: 'ANIL KUMAR', pfno: '' },
      ],
    });
    const result = await service.previewFromBuffer(payroll([row('539/33105', '', 'ANIL KUMAR')]));
    expect(result.rows[0].suggestions![0]).toMatchObject({ memberNo: '130028441' });
  });

  it('an H.O.NO. that is not digits is an Error, not a guess', async () => {
    const { service } = build();
    const result = await service.previewFromBuffer(payroll([row('539/33105', '', 'X')]));
    expect(result.rows[0].status).toBe('Error');
    expect(result.rows[0].remarks).toContain('digits only');
  });
});

describe('DemandImportService save', () => {
  it('writes a new demand row with the RD/CD, MD and MD1 columns and its RD installment', async () => {
    const { service, calls } = build({ existing: false });

    const result = await service.saveRows(4, 2026, [previewRow({ mdAmount: 5, md1Amount: 7, totalDemand: 142, fileTotal: 142 })], '1');

    expect(result).toMatchObject({ saved: 1, skipped: 0, flagged: 0 });
    const insert = calls.find(({ sql }) => sql.includes('INSERT INTO demand_master'));
    expect(insert?.sql).toContain('cd_amount, md_amount, md1_amount');
    expect(insert?.params).toEqual([4, 2026, '1001', '1', 9, 100, 20, 0, 0, 10, 5, 7, 142]);
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO rd_installment_ledger'))).toBe(true);
  });

  it('updates an existing demand row (and clears rd_amount) instead of inserting a duplicate', async () => {
    const { service, calls } = build({ existing: true });
    await service.saveRows(4, 2026, [previewRow({ mdAmount: 5, md1Amount: 7, totalDemand: 142, fileTotal: 142 })], '1');
    const update = calls.find(({ sql }) => sql.includes('UPDATE demand_master SET'));
    expect(update?.sql).toContain('cd_amount = $7, md_amount = $8, md1_amount = $9, rd_amount = 0');
    expect(update?.params).toEqual([4, 2026, 100, 20, 0, 0, 10, 5, 7, 142, '1', '1001']);
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO demand_master'))).toBe(false);
  });

  it('stores the interest with the emergency loan when the row has no regular loan', async () => {
    const { service, calls } = build({ existing: false });
    await service.saveRows(4, 2026, [previewRow({ rlnAmount: 0, alnAmount: 100 })], '1');
    const insert = calls.find(({ sql }) => sql.includes('INSERT INTO demand_master'));
    expect(insert?.params?.slice(5, 9)).toEqual([0, 0, 100, 20]);
  });

  it('skips invalid, duplicate, branch-mismatched and tampered rows, each with a reason', async () => {
    const { service } = build({ existing: true });

    const result = await service.saveRows(4, 2026, [
      previewRow({ key: 'a', rowNo: 2, status: 'Error', remarks: 'Missing member number' }),
      previewRow({ key: 'b', rowNo: 3 }),
      previewRow({ key: 'c', rowNo: 4 }),
      previewRow({ key: 'd', rowNo: 5, memberId: '1002' }),
      previewRow({ key: 'e', rowNo: 6, memberId: '1003', totalDemand: 999 }),
    ], '1');

    // b saves, c is the duplicate of b, d is unknown, e has a mismatched total
    expect(result).toMatchObject({ saved: 1, skipped: 4 });
    const reasons = Object.fromEntries(result.skippedDetails.map((d) => [d.rowNo, d.reason]));
    expect(reasons[2]).toContain('Missing member number');
    expect(reasons[4]).toContain('twice');
    expect(reasons[5]).toContain('was not found');
    expect(reasons[6]).toContain('parts add up');
  });

  it('ES-456: skips a member whose month is already posted, with that reason', async () => {
    const { service, calls } = build({ existing: true, posted: true });
    const result = await service.saveRows(4, 2026, [previewRow()], '1');
    expect(result).toMatchObject({ saved: 0, skipped: 1 });
    expect(result.skippedDetails[0].reason).toContain('already posted');
    expect(calls.some(({ sql }) => sql.includes('UPDATE demand_master SET'))).toBe(false);
  });

  it('ES-574: a member with no monthly RD/CD amount gets one from the first imported amount, effective that month', async () => {
    const { service, calls } = build({ existing: false, noConfig: true });
    await service.saveRows(4, 2026, [previewRow()], '1');
    const cfg = calls.find(({ sql }) => sql.includes('INSERT INTO rd_member_config'));
    expect(cfg?.params).toEqual(['1001', 2026, 10, '2026-04-01']);
    expect(cfg?.sql).toContain('DEMAND IMPORT');
  });

  it('ES-574: an amount that is already set is never changed by an import', async () => {
    const { service, calls } = build({ existing: false });
    await service.saveRows(4, 2026, [previewRow()], '1');
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO rd_member_config'))).toBe(false);
  });

  it('does not record an RD installment when the RD/CD amount is zero', async () => {
    const { service, calls } = build({ existing: true });
    await service.saveRows(4, 2026, [previewRow({ cdAmount: 0, totalDemand: 120, fileTotal: 120 })], '1');
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO rd_installment_ledger'))).toBe(false);
  });

  it('rolls back and wraps a write failure', async () => {
    const { service, qr } = build({ failOn: 'INSERT INTO demand_master' });
    await expect(service.saveRows(4, 2026, [previewRow()], '1')).rejects.toThrow(/Failed to save imported demand/);
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });
});

describe('ES-588: the import log', () => {
  it('records every file row (saved and skipped) with how the member was found, the file name and the user', async () => {
    const { service, calls } = build({ existing: true });
    const result = await service.saveRows(4, 2026, [
      previewRow({ rowNo: 2, honoGiven: '1001', psNo: 'PS1', nameInFile: 'Asha', matchMethod: 'HONO' }),
      previewRow({ key: 'x', rowNo: 3, memberId: '', status: 'Error', remarks: 'No member found for H.O.NO. 5' }),
    ], '1', { fileName: 'NANDINI.xlsx', savedBy: 'op1' });

    expect(result.batchId).toMatch(/^[0-9a-f-]{36}$/);
    const log = calls.find(({ sql }) => sql.includes('INSERT INTO demand_import_log'));
    expect(log).toBeDefined();
    const p = log!.params!;
    expect(p).toHaveLength(30);
    // row 1: saved, matched by H.O.NO., PS.NO. and name kept as given
    expect(p.slice(0, 15)).toEqual([result.batchId, 'NANDINI.xlsx', 2, 4, 2026, '1', '1001', '1001', 'PS1', 'Asha', '1001', 'HONO', 'SAVED', null, 'op1']);
    // row 2: skipped with the reason
    expect(p[15 + 12]).toBe('SKIPPED');
    expect(p[15 + 13]).toContain('No member found for H.O.NO. 5');
  });

  it('a failing log write never fails the import (savepoint is rolled back)', async () => {
    const { service, qr, calls } = build({ existing: true, failOn: 'INSERT INTO demand_import_log' });
    const result = await service.saveRows(4, 2026, [previewRow()], '1');
    expect(result.saved).toBe(1);
    expect(qr.commitTransaction).toHaveBeenCalled();
    expect(calls.some(({ sql }) => sql.includes('ROLLBACK TO SAVEPOINT demand_import_log'))).toBe(true);
  });

  it('creates the log table idempotently at start', async () => {
    const { service, dataSource } = build();
    await service.onModuleInit();
    expect(dataSource.query.mock.calls.some(([sql]: [string]) => sql.includes('CREATE TABLE IF NOT EXISTS demand_import_log'))).toBe(true);
  });
});

describe('ES-591: import strictness (Modify Business Rules)', () => {
  const twoMembers = [
    { mbno: 130023132, officeno: 4, dept_name: 'Ops', name: 'SHIV KUMAR NISHAD', pfno: '230425' },
    { mbno: 130028423, officeno: 4, dept_name: 'Ops', name: 'MAHESH CHANDRA KATARE', pfno: '230572' },
  ];
  const hono = (over: Partial<Record<string, any>> = {}) => previewRow({
    key: '2-130023132', memberId: '130023132', memberNoGiven: undefined, honoGiven: '23132', codePrefix: '13',
    nameInFile: 'SHIV KUMAR NISHAD', psNo: '230425', matchMethod: 'HONO', ...over,
  });

  it('reads the setting at every import; a missing, broken or unknown value means STRICT', async () => {
    expect(await build({ strictness: 'STANDARD' }).service.getStrictness()).toBe('STANDARD');
    expect(await build({ strictness: 'STRICT' }).service.getStrictness()).toBe('STRICT');
    expect(await build({ strictness: 'MISSING' }).service.getStrictness()).toBe('STRICT');
    expect(await build({ strictness: 'BROKEN' }).service.getStrictness()).toBe('STRICT');
  });

  it('the preview reports the active strictness and which warnings are real differences', async () => {
    const { service } = build({ members: twoMembers, strictness: 'STRICT' });
    const res = await service.previewFromBuffer(payroll([
      [202610, 'COPN013', 23132, 230425, 'SHIV KUMAR NISHAD', 225, 200, '', '', '', 8, 17],
      [202610, 'COPN013', 28423, 999999, 'SOMEBODY ELSE', 225, 200, '', '', '', 8, 17],
    ]));
    expect(res.strictness).toBe('STRICT');
    expect(res.rows[0].strictIssues).toBeUndefined();
    expect(res.rows[1].strictIssues).toHaveLength(2); // name and PS.NO. both differ
  });

  it('a member with no PS.NO. on record is information, not a strict problem', async () => {
    const { service } = build({ members: [{ ...twoMembers[0], pfno: '' }], strictness: 'STRICT' });
    const res = await service.previewFromBuffer(payroll([[202610, 'COPN013', 23132, 230425, 'SHIV KUMAR NISHAD', 225, 200, '', '', '', 8, 17]]));
    expect(res.rows[0].warnings).toHaveLength(1);
    expect(res.rows[0].strictIssues).toBeUndefined();
  });

  it('STRICT: a clean file is saved completely and the log write is mandatory', async () => {
    const { service } = build({ members: twoMembers, strictness: 'STRICT', existing: false });
    const result = await service.saveRows(11, 2026, [hono()], '4', { fileName: 'f.xlsx', savedBy: 'op' });
    expect(result).toMatchObject({ saved: 1, skipped: 0, strictness: 'STRICT' });
  });

  it('STRICT: one row with an error and NOTHING is saved; the refusal lists the problem and is logged as REFUSED', async () => {
    const { service, qr, calls } = build({ members: twoMembers, strictness: 'STRICT', existing: false });
    const good = hono();
    const bad = hono({ key: 'x', rowNo: 3, memberId: '', status: 'Error', remarks: 'No member found for H.O.NO. 99999', matchMethod: undefined });
    await expect(service.saveRows(11, 2026, [good, bad], '4')).rejects.toMatchObject({
      response: { message: expect.stringContaining('nothing was saved'), problems: [expect.objectContaining({ rowNo: 3 })] },
    });
    // everything written for the good row was inside the transaction that is rolled back
    expect(qr.rollbackTransaction).toHaveBeenCalled();
    // the only commit is the one of the refusal record
    expect(qr.commitTransaction).toHaveBeenCalledTimes(1);
    const log = calls.filter(({ sql }) => sql.includes('INSERT INTO demand_import_log')).pop()!;
    expect([log.params![12], log.params![15 + 12]]).toEqual(['REFUSED', 'REFUSED']);
    expect(String(log.params![13])).toContain('refused');
    expect(String(log.params![15 + 13])).toContain('No member found');
  });

  it('STRICT: the server does not trust a changed member number', async () => {
    const { service } = build({ members: [...twoMembers, { mbno: 1001, officeno: 4, name: 'Asha Patil', pfno: 'PS1' }], strictness: 'STRICT' });
    // the file said member 1001 but the request now carries another member
    await expect(service.saveRows(11, 2026, [previewRow({ memberId: '130023132', memberNoGiven: '1001', nameInFile: 'SHIV' })], '4'))
      .rejects.toMatchObject({ response: { problems: [expect.objectContaining({ reason: expect.stringContaining('is not 130023132') })] } });
  });

  it('STRICT: the server finds the member from the H.O.NO. again and refuses a different one', async () => {
    const { service } = build({ members: twoMembers, strictness: 'STRICT' });
    await expect(service.saveRows(11, 2026, [hono({ memberId: '130028423' })], '4'))
      .rejects.toMatchObject({ response: { problems: [expect.objectContaining({ reason: expect.stringContaining('finds member 130023132') })] } });
  });

  it('STRICT: a name that differs from the member is a problem for a member found by number or H.O.NO.', async () => {
    const { service } = build({ members: twoMembers, strictness: 'STRICT' });
    await expect(service.saveRows(11, 2026, [hono({ nameInFile: 'COMPLETELY DIFFERENT' })], '4'))
      .rejects.toMatchObject({ response: { problems: [expect.objectContaining({ reason: expect.stringContaining('differs from the member') })] } });
  });

  it('STRICT: a member picked by hand is accepted only if the server would suggest that member', async () => {
    const { service } = build({ members: twoMembers, strictness: 'STRICT', existing: false });
    const manual = hono({ matchMethod: 'MANUAL', honoGiven: '99999', nameInFile: 'SHIV KUMAR NISHAD' });
    await expect(service.saveRows(11, 2026, [manual], '4')).resolves.toMatchObject({ saved: 1 });
    // a tampered pick: member 130028423 is not a suggestion for this name
    await expect(service.saveRows(11, 2026, [hono({ matchMethod: 'MANUAL', memberId: '130028423', nameInFile: 'SHIV KUMAR NISHAD' })], '4'))
      .rejects.toMatchObject({ response: { problems: [expect.objectContaining({ reason: expect.stringContaining('not one of the members the server suggests') })] } });
  });

  it('STRICT: a member whose month is already posted refuses the whole file', async () => {
    const { service } = build({ members: twoMembers, strictness: 'STRICT', existing: true, posted: true });
    await expect(service.saveRows(11, 2026, [hono()], '4'))
      .rejects.toMatchObject({ response: { problems: [expect.objectContaining({ reason: expect.stringContaining('already posted') })] } });
  });

  it('STRICT: an import that cannot be recorded in the log is not allowed to happen', async () => {
    const { service, qr } = build({ members: twoMembers, strictness: 'STRICT', existing: false, failOn: 'INSERT INTO demand_import_log' });
    await expect(service.saveRows(11, 2026, [hono()], '4')).rejects.toThrow(/Failed to save imported demand/);
    expect(qr.commitTransaction).not.toHaveBeenCalled();
    expect(qr.rollbackTransaction).toHaveBeenCalled();
  });

  it('STRICT is the default when the rule is missing', async () => {
    const { service } = build({ members: twoMembers, strictness: 'MISSING', existing: false });
    await expect(service.saveRows(11, 2026, [hono({ status: 'Error', remarks: 'bad' })], '4')).rejects.toBeInstanceOf(Error);
  });

  it('STANDARD: unchanged - the clean row is saved, the bad row is skipped with its reason', async () => {
    const { service } = build({ members: twoMembers, strictness: 'STANDARD', existing: false });
    const result = await service.saveRows(11, 2026, [hono(), hono({ key: 'x', rowNo: 3, memberId: '', status: 'Error', remarks: 'No member found' })], '4');
    expect(result).toMatchObject({ saved: 1, skipped: 1, strictness: 'STANDARD' });
    expect(result.skippedDetails[0].reason).toContain('No member found');
  });
});
