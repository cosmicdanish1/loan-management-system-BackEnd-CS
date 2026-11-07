import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UtilityReportsService } from '../../../src/modules/report/services-v2/utility-reports.service';

describe('UtilityReportsService', () => {
  let service: UtilityReportsService;
  let dataSource: any;

  beforeEach(() => {
    dataSource = {
      query: jest.fn(),
    };
    service = new UtilityReportsService(dataSource);
  });

  describe('getWingList & getOfficeList', () => {
    it('returns distinct wings from division_master', async () => {
      dataSource.query.mockResolvedValueOnce([
        { wingno: '1', name: 'South Wing' },
        { wingno: '2', name: 'North Wing' },
      ]);

      const wings = await service.getWingList();
      expect(wings).toHaveLength(2);
      expect(wings[0]).toEqual({ wingNo: '1', name: 'South Wing' });
    });

    it('returns office list filtered by optional wingNo', async () => {
      dataSource.query.mockResolvedValueOnce([
        { officeno: '10', wingno: '1', name: 'Branch Office' },
      ]);

      const offices = await service.getOfficeList('1');
      expect(offices).toHaveLength(1);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('AND wingno = $1'),
        ['1'],
      );
    });
  });

  describe('getFinancialSummary', () => {
    it('calculates opening balance, period activity and closing balance per head', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          head_code: 'A1001',
          head_name: 'Cash in Hand',
          headtype: 'ASSET',
          opening_balance: '1000',
          period_debit: '500',
          period_credit: '200',
          closing_balance: '1300',
        },
      ]);

      const summary = await service.getFinancialSummary({
        fromDate: '2026-09-01',
        toDate: '2026-09-30',
        includeOpBal: true,
        hideZeroClosing: false,
        hideZeroTrans: false,
      });

      expect(summary).toHaveLength(1);
      expect(summary[0].headCode).toBe('A1001');
      expect(summary[0].closingBalance).toBe(1300);
    });

    it('filters out zero closing balance accounts when hideZeroClosing is true', async () => {
      dataSource.query.mockResolvedValueOnce([
        { head_code: 'A1', closing_balance: '0.00' },
        { head_code: 'A2', closing_balance: '500.00' },
      ]);

      const res = await service.getFinancialSummary({
        fromDate: '2026-09-01',
        toDate: '2026-09-30',
        includeOpBal: true,
        hideZeroClosing: true,
        hideZeroTrans: false,
      });

      expect(res).toHaveLength(1);
      expect(res[0].headCode).toBe('A2');
    });
  });

  describe('getAccountClosingRegister', () => {
    it('returns closed FD/RD accounts within specified month and year', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          account_no: 'RD1001',
          member_no: '101',
          member_name: 'Asha Patil',
          account_type: 'RD',
          statusdate: '2026-09-15',
          final_amount: '25000',
          remarks: 'Premature closure',
        },
      ]);

      const res = await service.getAccountClosingRegister({
        month: 9,
        year: 2026,
        accountType: 'RD',
      });

      expect(res).toHaveLength(1);
      expect(res[0].accountNo).toBe('RD1001');
      expect(res[0].accountType).toBe('RD');
      expect(res[0].finalAmount).toBe(25000);
    });

    it('rejects month < 1 or > 12 with BadRequestException', async () => {
      await expect(
        service.getAccountClosingRegister({ month: 13, year: 2026 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.getAccountClosingRegister({ month: 0, year: 2026 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects year outside valid range with BadRequestException', async () => {
      await expect(
        service.getAccountClosingRegister({ month: 9, year: 1980 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.getAccountClosingRegister({ month: 9, year: 2150 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getRecoveryDetails', () => {
    it('accepts month as number or 3-letter name and maps demand recovery parts', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          member_no: '1001',
          member_name: 'Asha Patil',
          demand_for_month: 9,
          demand_for_year: 2026,
          total_demand: '3500',
          rln_amt: '2000',
          eln_amt: '500',
          aln_amt: '0',
          mln_amt: '0',
          rd_amt: '1000',
          demand_posted: 'Y',
        },
      ]);

      const res = await service.getRecoveryDetails({
        memberNo: '1001',
        month: 'SEP',
        year: 2026,
      });

      expect(res).toBeDefined();
      expect(res.memberNo).toBe('1001');
      expect(res.demandMonth).toBe('SEP');
      expect(res.status).toBe('Posted');
      expect(res.loanRecoveries.regularLoan).toBe(2000);
      expect(res.depositRecoveries.recurringDeposit).toBe(1000);
    });

    it('throws NotFoundException when no recovery details found', async () => {
      dataSource.query.mockResolvedValueOnce([]);
      await expect(
        service.getRecoveryDetails({ memberNo: '9999', month: '9', year: 2026 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects invalid month text with BadRequestException', async () => {
      await expect(
        service.getRecoveryDetails({ memberNo: '1001', month: 'XYZ', year: 2026 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('diagnosticCheck', () => {
    it('runs integrity counts and returns status OK', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ count: '150' }]) // members
        .mockResolvedValueOnce([{ count: '80' }])  // loans
        .mockResolvedValueOnce([{ count: '220' }]); // deposits

      const res = await service.diagnosticCheck();
      expect(res.status).toBe('OK');
      expect(res.members).toBe('150');
      expect(res.loans).toBe('80');
      expect(res.deposits).toBe('220');
    });

    it('catches and returns status ERROR when database query fails', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('DB unreachable'));
      const res = await service.diagnosticCheck();
      expect(res.status).toBe('ERROR');
      expect(res.message).toBe('DB unreachable');
    });
  });
});
