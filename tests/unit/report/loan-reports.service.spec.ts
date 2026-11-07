import { LoanReportsService } from '../../../src/modules/report/services-v2/loan-reports.service';

describe('LoanReportsService', () => {
  let service: LoanReportsService;
  let dataSource: any;

  beforeEach(() => {
    dataSource = {
      query: jest.fn(),
    };
    service = new LoanReportsService(dataSource, {} as any);
  });

  describe('getDefaulterList', () => {
    const cand = (no: string, bal: string) => ({ member_no: no, member_name: 'M ' + no, office_name: 'O', loan_type: 'RLN', loan_case_no: 'C' + no, case_loans: '1', loan_amount: '100000', balance: bal, installments: 24, last_payment_date: null });
    // dueDate decides overdue: 2020 is long past, 2999 is not yet due
    const late = (penalDue: number, dueDate = '2020-01-01') => ({ unpaidInstallments: [{ dueDate, penalDue }] });
    const notDue = { unpaidInstallments: [{ dueDate: '2999-01-01', penalDue: 0 }] };
    let repayment: any;
    beforeEach(() => {
      repayment = { getDueStatus: jest.fn() };
      service = new LoanReportsService(dataSource, repayment);
    });

    it('lists only loans with an installment past grace, with months overdue and penal due', async () => {
      dataSource.query.mockResolvedValueOnce([cand('1', '50000'), cand('2', '40000'), cand('3', '30000')]);
      repayment.getDueStatus.mockImplementation(async (c: string) =>
        c === 'C1' ? late(375) : c === 'C2' ? notDue : { unpaidInstallments: [] });

      const r = await service.getDefaulterList({ minBalance: 5000 });

      expect(r.metadata.totalCount).toBe(1);
      expect(r.data[0]).toMatchObject({ memberNo: '1', penalDue: 375, balance: 50000 });
      expect(r.data[0].monthsOverdue).toBeGreaterThan(60);
    });

    it('orders by months overdue, then balance, then case no, and pages the result', async () => {
      dataSource.query.mockResolvedValueOnce([cand('1', '10000'), cand('2', '90000'), cand('3', '90000'), cand('4', '5000')]);
      repayment.getDueStatus.mockImplementation(async (c: string) => c === 'C4' ? late(10, '2010-01-01') : late(25));

      const all = await service.getDefaulterList({});
      expect(all.data.map((d: any) => d.loanCaseNo)).toEqual(['C4', 'C2', 'C3', 'C1']);

      const page = await service.getDefaulterList({ limit: 2, offset: 1 });
      expect(page.data.map((d: any) => d.loanCaseNo)).toEqual(['C2', 'C3']);
      expect(page.metadata).toEqual({ totalCount: 4, limit: 2, offset: 1, unresolvedLoans: 0 });
    });

    it('does not guess for loans that share a case number', async () => {
      dataSource.query.mockResolvedValueOnce([{ ...cand('1', '50000'), case_loans: '2' }, cand('2', '40000')]);
      repayment.getDueStatus.mockResolvedValue(late(0));
      const r = await service.getDefaulterList({ minBalance: 1 });
      expect(repayment.getDueStatus).toHaveBeenCalledTimes(1);
      expect(r.data.map((d: any) => d.memberNo)).toEqual(['2']);
      expect(r.metadata.unresolvedLoans).toBe(1);
    });

    it('filters by loanType when provided', async () => {
      dataSource.query.mockResolvedValueOnce([]);
      await service.getDefaulterList({ loanType: 'ELN' });
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('loan.loantype = $'),
        expect.arrayContaining(['ELN']),
      );
    });

    it('skips a loan whose schedule cannot be read instead of guessing', async () => {
      dataSource.query.mockResolvedValueOnce([cand('1', '50000')]);
      repayment.getDueStatus.mockRejectedValue(new Error('no schedule'));
      const r = await service.getDefaulterList({ loanType: 'X' });
      expect(r.data).toEqual([]);
    });

    it('two simultaneous requests share one calculation (Dashboard + report open together)', async () => {
      dataSource.query.mockResolvedValue([cand('1', '50000'), cand('2', '40000')]);
      repayment.getDueStatus.mockResolvedValue(late(10));
      const [a, b] = await Promise.all([service.getDefaulterList({ minBalance: 1 }), service.getDefaulterList({ minBalance: 1 })]);
      expect(a.metadata.totalCount).toBe(2);
      expect(b.metadata.totalCount).toBe(2);
      expect(dataSource.query).toHaveBeenCalledTimes(1);
      expect(repayment.getDueStatus).toHaveBeenCalledTimes(2);
    });

    it('a list older than 5 minutes is served at once while one background run refreshes it', async () => {
      const realNow = Date.now;
      let now = realNow();
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        dataSource.query.mockResolvedValue([cand('1', '50000')]);
        repayment.getDueStatus.mockResolvedValue(late(10));
        await service.getDefaulterList({ minBalance: 1 });
        expect(dataSource.query).toHaveBeenCalledTimes(1);

        now += 10 * 60_000; // stale, but younger than 6 hours
        dataSource.query.mockResolvedValue([cand('1', '50000'), cand('2', '40000')]);
        const stale = await service.getDefaulterList({ minBalance: 1 });
        expect(stale.metadata.totalCount).toBe(1); // the old list, no waiting
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(dataSource.query).toHaveBeenCalledTimes(2); // refresh was started
        const fresh = await service.getDefaulterList({ minBalance: 1 });
        expect(fresh.metadata.totalCount).toBe(2); // and its result is used next time
      } finally {
        (Date.now as any).mockRestore?.();
        Date.now = realNow;
      }
    });

    it('a list older than 6 hours is not served: the caller waits for a fresh run', async () => {
      const realNow = Date.now;
      let now = realNow();
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        dataSource.query.mockResolvedValue([cand('1', '50000')]);
        repayment.getDueStatus.mockResolvedValue(late(10));
        await service.getDefaulterList({ minBalance: 1 });
        now += 7 * 60 * 60_000;
        dataSource.query.mockResolvedValue([cand('1', '50000'), cand('2', '40000')]);
        const r = await service.getDefaulterList({ minBalance: 1 });
        expect(r.metadata.totalCount).toBe(2);
      } finally {
        (Date.now as any).mockRestore?.();
        Date.now = realNow;
      }
    });

    it('rejects a bad limit or offset', async () => {
      await expect(service.getDefaulterList({ limit: -1 })).rejects.toThrow('limit');
      await expect(service.getDefaulterList({ offset: 1.5 })).rejects.toThrow('offset');
    });
  });

  describe('getNewLoanDisbursed', () => {
    it('lists loans disbursed within specified date range', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ count: '1' }]) // countRes
        .mockResolvedValueOnce([
          {
            disbursement_date: '2026-09-15',
            loan_case_no: 'LC101',
            member_no: '1002',
            member_name: 'Suresh Patil',
            loan_amount: '200000',
            loan_type: 'RLN',
            interest_rate: '9.5',
            installments: 36,
          },
        ]); // data

      const res = await service.getNewLoanDisbursed({
        fromDate: '2026-09-01',
        toDate: '2026-09-30',
      });

      expect(res).toBeDefined();
      expect(res.data).toHaveLength(1);
    });

    it('slices unvalidated date strings without validating date format', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      // Gap: service does not validate fromDate / toDate before slicing to length 10
      await expect(
        service.getNewLoanDisbursed({
          fromDate: 'invalid-date',
          toDate: '2026-09-30',
        }),
      ).rejects.toThrow();
    });
  });

  describe('getMemberLoanLedger', () => {
    it('fetches schedule, repayments and balance trail for member loan', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ member_name: 'Asha Patil' }]) // memberQuery
        .mockResolvedValueOnce([
          {
            loancaseno: 'LC01',
            mbno: '1001',
            loan_amt: '50000',
            payment_date: '2026-01-01',
            loantype: 'RLN',
          },
        ]) // loanRows
        .mockResolvedValueOnce([
          {
            date: new Date('2026-08-10'),
            payment_amount: 5000,
            principal_amount: 4500,
            interest_amount: 500,
            penal_amount: 0,
            receipt_no: 'R101',
            narration: 'EMI Payment',
            is_payroll_lag_credit: false,
          },
        ]) // payments
        .mockResolvedValueOnce([
          { principal_paid: '5000' },
        ]); // before

      const ledger = await service.getMemberLoanLedger({
        memberNo: '1001',
        loanCaseNo: 'LC01',
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
      });

      expect(ledger).toBeDefined();
      expect(ledger.transactions).toHaveLength(1);
    });

    it('rejects missing or empty memberNo', async () => {
      dataSource.query.mockResolvedValueOnce([]);
      // Gap: accepts empty memberNo without validation
      await expect(
        service.getMemberLoanLedger({ memberNo: '' }),
      ).rejects.toThrow();
    });
  });

  describe('getSuretyRegister', () => {
    it('returns loans where member stands as guarantor/surety', async () => {
      dataSource.query
        .mockResolvedValueOnce([{ count: '1' }]) // totalCountRes
        .mockResolvedValueOnce([
          {
            surety_mbno: '1001',
            surety_name: 'Asha Patil',
            member_no: '1050',
            member_name: 'Vijay Shinde',
            loan_no: 'LC55',
            loan_type: 'RLN',
            loan_amount: '100000',
            outstanding_balance: '80000',
          },
        ]); // result

      const sureties = await service.getSuretyRegister({ memberNo: '1001' });

      expect(sureties).toBeDefined();
      expect(sureties).toHaveLength(1);
      expect(sureties[0].suretyMbno).toBe('1001');
      expect(sureties[0].outstandingBalance).toBe(80000);
    });
  });

  describe('getLoanNilCertificate', () => {
    it('verifies that member has no active or unpaid loans before issuing nil certificate', async () => {
      dataSource.query
        .mockResolvedValueOnce([]) // activeLoans
        .mockResolvedValueOnce([{ member_name: 'Asha Patil', doj: '2015-01-01' }]); // memberRes

      const cert = await service.getLoanNilCertificate('1001');

      expect(cert.success).toBe(true);
      expect(cert.data.isNil).toBe(true);
      expect(cert.data.outstandingLoans).toHaveLength(0);
    });

    it('reports outstanding loans when balance is remaining', async () => {
      dataSource.query
        .mockResolvedValueOnce([
          { head_name: 'RLN', head_code: 'LC01', balance: '12000' },
        ]) // activeLoans
        .mockResolvedValueOnce([{ member_name: 'Asha Patil', doj: '2015-01-01' }]); // memberRes

      const cert = await service.getLoanNilCertificate('1001');

      expect(cert.success).toBe(true);
      expect(cert.data.isNil).toBe(false);
      expect(cert.data.outstandingLoans).toHaveLength(1);
    });
  });
});
