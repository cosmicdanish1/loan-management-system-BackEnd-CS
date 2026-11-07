import { BadRequestException } from '@nestjs/common';
import { MemberReportsService } from '../../../src/modules/report/services-v2/member-reports.service';

describe('MemberReportsService', () => {
  let service: MemberReportsService;
  let dataSource: any;

  beforeEach(() => {
    dataSource = {
      query: jest.fn(),
    };
    service = new MemberReportsService(dataSource);
  });

  describe('getMemberProfile', () => {
    it('returns combined profile data including personal, nominee and balances', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          mbno: '1001',
          f_name: 'Asha',
          m_name: 'K',
          l_name: 'Patil',
          full_name: 'Asha K Patil',
          desig: 'Clerk',
          present_address: 'Pune',
          dob: '1985-05-15',
          dor: '2045-05-31',
          pfno: 'PF1234',
          basic_pay: '45000',
          nominee_name: 'Rohan Patil',
          nominee_address: 'Pune',
          nominee_relation: 'Son',
          office_name: 'Head Office',
          share_balance: '5000',
          cd_balance: '12000',
          regular_loan: '50000',
          emergency_loan: '10000',
          isactive: 'Y',
        },
      ]);

      const profile = await service.getMemberProfile({ memberNo: '1001' });

      expect(profile).toBeDefined();
      expect(profile?.memberNo).toBe('1001');
      expect(profile?.fullName).toBe('Asha K Patil');
      expect(profile?.nominee.name).toBe('Rohan Patil');
      expect(profile?.balances.shares).toBe(5000);
      expect(profile?.isActive).toBe(true);
    });

    it('returns null instead of throwing NotFoundException when member does not exist', async () => {
      dataSource.query.mockResolvedValueOnce([]); // No member found
      // Gap: service returns null instead of throwing NotFoundException
      await expect(service.getMemberProfile({ memberNo: '9999' })).rejects.toThrow();
    });

    it('rejects empty or whitespace member number', async () => {
      dataSource.query.mockResolvedValueOnce([]);
      // Gap: accepts whitespace memberNo and executes query
      await expect(service.getMemberProfile({ memberNo: '   ' })).rejects.toThrow();
    });
  });

  describe('getMemberStatement', () => {
    it('returns ledger entries between fromDate and toDate with opening balance', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ mbno: '1001', full_name: 'Asha Patil' }]) // member info
        .mockResolvedValueOnce([{ count: '1' }]) // count
        .mockResolvedValueOnce([
          {
            trans_date: '2026-09-05',
            voucher_no: 'R01',
            narration: 'Deposit',
            trans_type: 'CR',
            amount: '1000',
          },
        ]) // transactions
        .mockResolvedValueOnce([{ balance: '2500' }]); // opening balance

      const statement = await service.getMemberStatement({
        memberNo: '1001',
        fromDate: '2026-09-01',
        toDate: '2026-09-30',
      });

      expect(statement).toBeDefined();
      expect(statement.transactions).toHaveLength(1);
    });
  });

  describe('getVotersList', () => {
    it('filters voters list by active status and minimum share holding criteria', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ count: '1' }]) // count
        .mockResolvedValueOnce([
          {
            mbno: '1001',
            member_name: 'Asha Patil',
            office_name: 'Central',
            share_balance: 500,
          },
        ]); // data

      const list = await service.getVotersList({
        asOnDate: '2026-09-30',
        minShareAmount: 100,
      } as any);

      expect(list).toBeDefined();
      expect(list.data).toHaveLength(1);
    });
  });

  describe('getMemberBalanceRangeReport', () => {
    it('queries members within minBalance and maxBalance range', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ count: '1' }]) // count
        .mockResolvedValueOnce([
          { mbno: '1001', member_name: 'Asha Patil', total_balance: '15000' },
        ]); // data

      const report = await service.getMemberBalanceRangeReport({
        minBalance: 10000,
        maxBalance: 20000,
      });

      expect(report).toBeDefined();
      expect(report.data).toHaveLength(1);
    });

    it('rejects when minBalance is greater than maxBalance', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      // Gap: service does not validate minBalance <= maxBalance and returns empty results
      await expect(
        service.getMemberBalanceRangeReport({
          minBalance: 50000,
          maxBalance: 10000,
        }),
      ).rejects.toThrow();
    });
  });

  describe('getAccountBalanceReport', () => {
    it('queries member accounts within account number range', async () => {
      dataSource.query.mockResolvedValueOnce([
        { mbno: '1001', balance: '500' },
        { mbno: '1002', balance: '1200' },
      ]);

      const res = await service.getAccountBalanceReport({
        fromAccountNo: '1001',
        toAccountNo: '1010',
      });

      expect(res).toBeDefined();
      expect(dataSource.query).toHaveBeenCalled();
    });
  });
});
