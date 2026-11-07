import { DepositReportsService } from '../../../src/modules/report/services-v2/deposit-reports.service';

describe('DepositReportsService', () => {
  let service: DepositReportsService;
  let dataSource: any;

  beforeEach(() => {
    dataSource = {
      query: jest.fn(),
    };
    service = new DepositReportsService(dataSource);
  });

  describe('getRDStatement', () => {
    it('returns RD statement with installments, interest credits and balance', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ member_name: 'Asha Patil' }]) // memberRows
        .mockResolvedValueOnce([
          {
            yearcode: 1,
            start_date: '2025-04-01',
            end_date: '2026-03-31',
            opening_balance: '0',
            monthly_rd_amount: '1000',
            total_installments_due: 12,
            total_installments_paid: 12,
            total_missed: 0,
            payment_pattern_detected: 'REGULAR',
            final_eligible_full_interest: 'true',
            rd_installment_interest: '450',
            opening_balance_interest: '0',
            total_interest_credited: '450',
            closing_balance: '12450',
          },
        ]) // closedYears
        .mockResolvedValueOnce([]); // openYears

      const statement = await service.getRDStatement({
        memberNo: '1001',
        fromDate: '2025-04-01',
        toDate: '2026-03-31',
      });

      expect(statement).toBeDefined();
      expect(dataSource.query).toHaveBeenCalled();
    });

    it('returns empty array when memberNo is omitted', async () => {
      const res = await service.getRDStatement({});
      expect(res).toEqual([]);
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('getSavingStatement', () => {
    it('returns savings deposits, withdrawals and running balance', async () => {
      dataSource.query
        .mockResolvedValueOnce([
          { member_name: 'Asha Patil', cd_balance: '12000' },
        ]) // memberQuery
        .mockResolvedValueOnce([{ balance: '5000' }]) // opBalQuery
        .mockResolvedValueOnce([
          {
            date: '2026-08-01',
            voucher_no: 'R01',
            narration: 'Cash Deposit',
            type: 'CR',
            amount: '2000',
          },
          {
            date: '2026-08-15',
            voucher_no: 'P01',
            narration: 'Cash Withdrawal',
            type: 'DR',
            amount: '1500',
          },
        ]); // transQuery

      const statement = await service.getSavingStatement({
        memberNo: '1001',
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
      });

      expect(statement).toBeDefined();
      expect(statement?.memberName).toBe('Asha Patil');
      expect(statement?.openingBalance).toBe(5000);
      expect(statement?.transactions).toHaveLength(2);
      expect(statement?.closingBalance).toBe(5500); // 5000 + 2000 - 1500
    });

    it('returns null when member is not found in member_master', async () => {
      dataSource.query.mockResolvedValueOnce([]); // No member
      const res = await service.getSavingStatement({ memberNo: '9999' });
      expect(res).toBeNull();
    });
  });

  describe('getDepositMaturity', () => {
    it('lists deposits maturing within target period', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          certificate_no: 'FD100',
          member_no: '1001',
          member_name: 'Asha Patil',
          deposit_amount: '50000',
          maturity_amount: '56000',
          maturity_date: '2026-10-15',
          roi: '7.5',
        },
      ]);

      const maturities = await service.getDepositMaturity({
        fromDate: '2026-10-01',
        toDate: '2026-10-31',
      });

      expect(maturities).toBeDefined();
      expect(dataSource.query).toHaveBeenCalled();
    });
  });

  describe('getShareCertificate', () => {
    it('returns share certificate printing layout with member and share distinct numbers', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          certificate_no: 'SC-2026-01',
          member_no: '1001',
          member_name: 'Asha Patil',
          shares_count: 50,
          from_share_no: 1001,
          to_share_no: 1050,
          face_value: 10,
        },
      ]);

      const cert = await service.getShareCertificate({ memberNo: '1001' });
      expect(cert).toBeDefined();
      expect(dataSource.query).toHaveBeenCalled();
    });
  });

  describe('getLienAccountInformation', () => {
    it('lists deposit and share accounts currently held under lien against loans', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          member_no: '1001',
          account_type: 'RD',
          account_no: 'RD001',
          lien_amount: '25000',
          loan_case_no: 'LC05',
          borrower_member_no: '1001',
        },
      ]);

      const liens = await service.getLienAccountInformation();
      expect(liens).toBeDefined();
      expect(dataSource.query).toHaveBeenCalled();
    });
  });
});
