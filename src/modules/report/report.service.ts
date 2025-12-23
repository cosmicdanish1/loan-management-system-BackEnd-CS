import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CashBook } from './entities/cash-book.entity';
import { HeadMaster } from '../print-voucher/entities/head-master.entity';
import { Ledger } from '../print-voucher/entities/ledger.entity';
import { LoanMaster } from '../loan/entities/loan-master.entity';
import { MemberMaster } from '../member/entities/member-master.entity';
import { CashBookMonthlyDto } from './dto/cash-book-monthly.dto';
import { DetailLedgerDto } from './dto/detail-ledger.dto';
import { BankDetailLedgerDto } from './dto/bank-detail-ledger.dto';
import { DefaulterListDto } from './dto/defaulter-list.dto';
import { NewLoanDisbursedDto } from './dto/new-loan-disbursed.dto';
import { MemberLoanLedgerDto, LoanCategory } from './dto/member-loan-ledger.dto';
import { FinancialSummaryDto } from './dto/financial-summary.dto';
import { VotersListDto } from './dto/voters-list.dto';
import { DividendReportDto } from './dto/dividend-report.dto';
import { DividendPaidDto } from './dto/dividend-paid.dto';
import { InterestListDto } from './dto/interest-list.dto';
import { DividendWarrantDto } from './dto/dividend-warrant.dto';
import { CreateReportScheduleDto } from './dto/create-report-schedule.dto';
import { ExecuteReportScheduleDto } from './dto/execute-report-schedule.dto';
import { ReportScheduleHeader } from './entities/report-schedule-header.entity';
import { ReportScheduleDetail } from './entities/report-schedule-detail.entity';

@Injectable()
export class ReportService {
  constructor(
    @InjectRepository(CashBook)
    private cashBookRepository: Repository<CashBook>,
    @InjectRepository(HeadMaster)
    private headMasterRepository: Repository<HeadMaster>,
    @InjectRepository(Ledger)
    private ledgerRepository: Repository<Ledger>,
    @InjectRepository(LoanMaster)
    private loanMasterRepository: Repository<LoanMaster>,
    @InjectRepository(MemberMaster)
    private memberMasterRepository: Repository<MemberMaster>,
    @InjectRepository(ReportScheduleHeader)
    private scheduleHeaderRepository: Repository<ReportScheduleHeader>,
    @InjectRepository(ReportScheduleDetail)
    private scheduleDetailRepository: Repository<ReportScheduleDetail>,
  ) { }
  s
  async getCashBookMonthly(dto: CashBookMonthlyDto) {
    const { month, year } = dto;

    // Map month name to number (0-11)
    const monthMap: { [key: string]: number } = {
      'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
      'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
    };

    // Handle full month names if necessary, but frontend sends 'Apr-2015' format usually split
    const monthIndex = monthMap[month.substring(0, 3)];

    const startDate = new Date(year, monthIndex, 1);
    const endDate = new Date(year, monthIndex + 1, 0);

    // Format dates for query (YYYY-MM-DD)
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    // SQL Query with proper NULL handling
    const result = await this.cashBookRepository
      .createQueryBuilder('cb')
      .select('cb.headcode', 'code')
      .addSelect('MAX(cb.headname)', 'headName')
      // Total Receipt = rcash + rtransfer (NULL-safe)
      .addSelect(
        'SUM(COALESCE(cb.rcash, 0) + COALESCE(cb.rtransfer, 0))',
        'receipt'
      )
      // Total Payment = pcash + ptransfer (NULL-safe)
      .addSelect(
        'SUM(COALESCE(cb.pcash, 0) + COALESCE(cb.ptransfer, 0))',
        'payment'
      )
      // Filter by date range and exclude NULL dates
      .where('cb.trans_date IS NOT NULL')
      .andWhere('cb.trans_date >= :startDate', { startDate: startStr })
      .andWhere('cb.trans_date <= :endDate', { endDate: endStr })
      // Group by headcode (and implicitly headname via MAX)
      .groupBy('cb.headcode')
      .getRawMany();

    return result.map((item, index) => ({
      key: index.toString(),
      code: item.code || '',
      headName: item.headName || 'Unknown Head',
      receipt: parseFloat(item.receipt) || 0,
      payment: parseFloat(item.payment) || 0,
    }));
  }



  async getDetailLedger(dto: DetailLedgerDto) {
    const { head_code, from_date, to_date } = dto;

    // Get head name
    const head = await this.headMasterRepository.findOne({
      where: { code: head_code }
    });

    const headName = head?.head_name || 'Unknown Head';

    // Get transactions for this head within date range
    const transactions = await this.ledgerRepository
      .createQueryBuilder('l')
      .select([
        'l.trans_date as trans_date',
        'l.receipt_vchr_no as voucher_no',
        'l.narration as narration',
        'l.trans_type as trans_type',
        'l.trans_amt as amount'
      ])
      .where('l.code = :head_code', { head_code })
      .andWhere('l.trans_date >= :from_date', { from_date })
      .andWhere('l.trans_date <= :to_date', { to_date })
      .orderBy('l.trans_date', 'ASC')
      .addOrderBy('l.trans_no', 'ASC')
      .getRawMany();

    // Calculate running balance and separate debit/credit
    let runningBalance = 0;
    const ledgerData = transactions.map((trans, index) => {
      const isDebit = trans.trans_type === 'DR';
      const debit = isDebit ? parseFloat(trans.amount) || 0 : 0;
      const credit = !isDebit ? parseFloat(trans.amount) || 0 : 0;

      runningBalance += debit - credit;

      return {
        key: index.toString(),
        date: trans.trans_date,
        voucherNo: trans.voucher_no || '-',
        narration: trans.narration || '',
        debit: debit,
        credit: credit,
        balance: runningBalance
      };
    });

    return {
      headCode: head_code,
      headName: headName,
      fromDate: from_date,
      toDate: to_date,
      transactions: ledgerData
    };
  }

  async getHeadList() {
    const heads = await this.headMasterRepository
      .createQueryBuilder('hm')
      .select(['hm.code as code', 'hm.head_name as head_name'])
      .orderBy('hm.head_name', 'ASC')
      .getRawMany();

    return heads.map(h => ({
      code: h.code,
      name: h.head_name
    }));
  }

  async getBankList() {
    const banks = await this.headMasterRepository
      .createQueryBuilder('hm')
      .select(['hm.code as code', 'hm.head_name as head_name'])
      .where("UPPER(hm.head_name) LIKE '%BANK%' OR UPPER(hm.head_name) LIKE '%ACCOUNT%'")
      .orderBy('hm.head_name', 'ASC')
      .getRawMany();

    return banks.map(b => ({
      code: b.code,
      name: b.head_name
    }));
  }

  async getBankDetailLedger(dto: BankDetailLedgerDto) {
    const { bank_head_code, from_date, to_date } = dto;

    // Get bank name
    const bank = await this.headMasterRepository.findOne({
      where: { code: bank_head_code }
    });

    const bankName = bank?.head_name || 'Unknown Bank';

    // For now, set opening balance to 0 - we'll add calculation later
    const openingBalance = 0;

    // Get transactions within date range
    const transactions = await this.ledgerRepository
      .createQueryBuilder('l')
      .select([
        'l.trans_date as trans_date',
        'l.receipt_vchr_no as voucher_no',
        'l.narration as narration',
        'l.trans_type as trans_type',
        'CAST(l.trans_amt AS numeric) as amount'
      ])
      .where('l.code = :bank_head_code', { bank_head_code })
      .andWhere('l.trans_date >= :from_date', { from_date })
      .andWhere('l.trans_date <= :to_date', { to_date })
      .orderBy('l.trans_date', 'ASC')
      .addOrderBy('l.trans_no', 'ASC')
      .getRawMany();

    // Calculate running balance starting from opening balance
    let runningBalance = openingBalance;
    const ledgerData = transactions.map((trans, index) => {
      const isDebit = trans.trans_type === 'DR';
      const debit = isDebit ? parseFloat(trans.amount) || 0 : 0;
      const credit = !isDebit ? parseFloat(trans.amount) || 0 : 0;

      runningBalance += debit - credit;

      return {
        key: index.toString(),
        date: trans.trans_date,
        voucherNo: trans.voucher_no || '-',
        narration: trans.narration || '',
        debit: debit,
        credit: credit,
        balance: runningBalance
      };
    });

    return {
      bankCode: bank_head_code,
      bankName: bankName,
      fromDate: from_date,
      toDate: to_date,
      openingBalance: openingBalance,
      transactions: ledgerData
    };
  }

  async getDefaulterList(dto: DefaulterListDto) {
    const minBalance = dto.minBalance || 0;

    // Get all loans with outstanding balance > minBalance
    const defaulters = await this.loanMasterRepository
      .createQueryBuilder('loan')
      .leftJoin(MemberMaster, 'member', 'member.mbno = loan.mbno')
      .select([
        'loan.mbno as mbno',
        'loan.loantype as loantype',
        'loan.loancaseno as loancaseno',
        'CAST(loan.loan_amt AS numeric) as loan_amt',
        'CAST(loan.balance AS numeric) as balance',
        'CAST(loan.instal_amt AS numeric) as instal_amt',
        'loan.no_of_instal as no_of_instal',
        'loan.purpose as purpose',
        'loan.payment_date as payment_date',
        'member.f_name as f_name',
        'member.m_name as m_name',
        'member.l_name as l_name',
        'member.desig as desig',
        'member.dept_name as dept_name'
      ])
      .where('CAST(loan.balance AS numeric) > :minBalance', { minBalance })
      .orderBy('CAST(loan.balance AS numeric)', 'DESC')
      .getRawMany();

    // Process and return defaulter data
    return defaulters.map((item, index) => ({
      key: index.toString(),
      mbno: item.mbno,
      memberName: [item.f_name, item.m_name, item.l_name].filter(Boolean).join(' ').trim() || 'Unknown',
      designation: item.desig || '-',
      department: item.dept_name || '-',
      loanType: item.loantype,
      loanCaseNo: item.loancaseno,
      loanAmount: parseFloat(item.loan_amt) || 0,
      balance: parseFloat(item.balance) || 0,
      installmentAmount: parseFloat(item.instal_amt) || 0,
      numberOfInstallments: parseInt(item.no_of_instal) || 0,
      purpose: item.purpose || '-',
      paymentDate: item.payment_date
    }));
  }

  async getLoanTypes() {
    // Get distinct loan types from loan_master
    const loanTypes = await this.loanMasterRepository
      .createQueryBuilder('loan')
      .select('DISTINCT loan.loantype', 'loantype')
      .orderBy('loan.loantype', 'ASC')
      .getRawMany();

    return loanTypes.map(lt => ({
      code: lt.loantype,
      name: lt.loantype // You can enhance this with a mapping to full names if needed
    }));
  }

  async getNewLoanDisbursed(dto: NewLoanDisbursedDto) {
    const { loanType, fromDate } = dto;

    // Build query
    let query = this.loanMasterRepository
      .createQueryBuilder('loan')
      .leftJoin(MemberMaster, 'member', 'member.mbno = loan.mbno')
      .select([
        'loan.mbno as mbno',
        'loan.loantype as loantype',
        'loan.loancaseno as loancaseno',
        'CAST(loan.loan_amt AS numeric) as loan_amt',
        'loan.payment_date as payment_date',
        'loan.purpose as purpose',
        'CAST(loan.instal_amt AS numeric) as instal_amt',
        'loan.no_of_instal as no_of_instal',
        'member.f_name as f_name',
        'member.m_name as m_name',
        'member.l_name as l_name',
        'member.desig as desig',
        'member.dept_name as dept_name'
      ])
      .where('loan.payment_date >= :fromDate', { fromDate });

    // Add loan type filter if provided
    if (loanType) {
      query = query.andWhere('loan.loantype = :loanType', { loanType });
    }

    const loans = await query
      .orderBy('loan.payment_date', 'DESC')
      .getRawMany();

    // Process and return loan data
    return loans.map((item, index) => ({
      key: index.toString(),
      mbno: item.mbno,
      memberName: [item.f_name, item.m_name, item.l_name].filter(Boolean).join(' ').trim() || 'Unknown',
      designation: item.desig || '-',
      department: item.dept_name || '-',
      loanType: item.loantype,
      loanCaseNo: item.loancaseno,
      loanAmount: parseFloat(item.loan_amt) || 0,
      installmentAmount: parseFloat(item.instal_amt) || 0,
      numberOfInstallments: parseInt(item.no_of_instal) || 0,
      purpose: item.purpose || '-',
      disbursementDate: item.payment_date
    }));
  }

  async getMemberLoanLedger(dto: MemberLoanLedgerDto) {
    const { memberCode, asOnDate, loanCategory } = dto;

    // Map loan category to head code
    // Note: You may need to adjust these codes based on your headmaster table
    const headCodeMap = {
      [LoanCategory.REGULAR]: 'RLN', // Regular Loan - adjust if needed
      [LoanCategory.SHORT_TERM]: 'SLN' // Short Term Loan - adjust if needed
    };

    const headCode = headCodeMap[loanCategory];

    // Get member details
    const member = await this.memberMasterRepository.findOne({
      where: { mbno: memberCode }
    });

    const memberName = member ? [member.f_name, member.m_name, member.l_name].filter(Boolean).join(' ').trim() : 'Unknown';

    // Get head details
    const head = await this.headMasterRepository.findOne({
      where: { code: headCode }
    });

    const headName = head?.head_name || loanCategory;

    // Fetch transactions up to asOnDate
    const transactions = await this.ledgerRepository
      .createQueryBuilder('l')
      .select([
        'l.trans_date as trans_date',
        'l.receipt_vchr_no as voucher_no',
        'l.narration as narration',
        'l.trans_type as trans_type',
        'CAST(l.trans_amt AS numeric) as amount'
      ])
      .where('l.code = :headCode', { headCode })
      .andWhere('l.trans_date <= :asOnDate', { asOnDate })
      // If your ledger table has member_code column, add this filter:
      // .andWhere('l.member_code = :memberCode', { memberCode })
      .orderBy('l.trans_date', 'ASC')
      .addOrderBy('l.trans_no', 'ASC')
      .getRawMany();

    // Calculate running balance
    let runningBalance = 0;
    const ledgerData = transactions.map((trans, index) => {
      const isDebit = trans.trans_type === 'DR';
      const debit = isDebit ? parseFloat(trans.amount) || 0 : 0;
      const credit = !isDebit ? parseFloat(trans.amount) || 0 : 0;

      // For loans: Debit = Loan Given, Credit = Repayment
      runningBalance += debit - credit;

      return {
        key: index.toString(),
        date: trans.trans_date,
        voucherNo: trans.voucher_no || '-',
        narration: trans.narration || '',
        debit: debit,
        credit: credit,
        balance: runningBalance
      };
    });

    return {
      memberCode: memberCode,
      memberName: memberName,
      loanCategory: loanCategory,
      headCode: headCode,
      headName: headName,
      asOnDate: asOnDate,
      outstandingBalance: runningBalance,
      transactions: ledgerData
    };
  }

  async getFinancialSummary(dto: FinancialSummaryDto) {
    const { fromDate, toDate, includeOpBal, hideZeroClosing, hideZeroTrans } = dto;

    try {
      // Build the raw SQL query with conditional aggregation
      const query = `
        SELECT 
          h.code as head_code,
          h.head_name,
          h.headtype,
          
          -- 1. Calculate Opening Balance (Everything BEFORE fromDate)
          COALESCE(SUM(CASE 
            WHEN $3::boolean = true AND l.trans_date < $1::date
            THEN (
              CASE 
                WHEN l.trans_type = 'CR' THEN l.trans_amt::numeric
                WHEN l.trans_type = 'DR' THEN -l.trans_amt::numeric
                ELSE 0
              END
            )
            ELSE 0 
          END), 0) AS opening_balance,

          -- 2. Calculate Period Activity (Between Dates)
          COALESCE(SUM(CASE 
            WHEN l.trans_date >= $1::date AND l.trans_date <= $2::date AND l.trans_type = 'DR'
            THEN l.trans_amt::numeric
            ELSE 0 
          END), 0) AS period_debit,
          
          COALESCE(SUM(CASE 
            WHEN l.trans_date >= $1::date AND l.trans_date <= $2::date AND l.trans_type = 'CR'
            THEN l.trans_amt::numeric
            ELSE 0 
          END), 0) AS period_credit,

          -- 3. Calculate Total Closing Balance (All transactions up to toDate)
          COALESCE(SUM(CASE
            WHEN l.trans_date <= $2::date
            THEN (
              CASE 
                WHEN l.trans_type = 'CR' THEN l.trans_amt::numeric
                WHEN l.trans_type = 'DR' THEN -l.trans_amt::numeric
                ELSE 0
              END
            )
            ELSE 0
          END), 0) AS closing_balance

        FROM 
          headmaster h
        LEFT JOIN 
          ledger l ON h.code = l.code
        GROUP BY 
          h.code, h.head_name, h.headtype
        ORDER BY 
          h.code
      `;

      const rawResults = await this.headMasterRepository.query(query, [
        fromDate,
        toDate,
        includeOpBal
      ]);

      // Filter results based on suppression options
      let filteredResults = rawResults;

      if (hideZeroClosing) {
        filteredResults = filteredResults.filter(row =>
          Math.abs(parseFloat(row.closing_balance || '0')) > 0.01
        );
      }

      if (hideZeroTrans) {
        filteredResults = filteredResults.filter(row => {
          const periodActivity = parseFloat(row.period_debit || '0') + parseFloat(row.period_credit || '0');
          return periodActivity > 0.01;
        });
      }

      // Format the results
      return filteredResults.map((row, index) => ({
        key: index.toString(),
        headCode: row.head_code,
        headName: row.head_name,
        headType: row.headtype,
        openingBalance: parseFloat(row.opening_balance || '0'),
        periodDebit: parseFloat(row.period_debit || '0'),
        periodCredit: parseFloat(row.period_credit || '0'),
        closingBalance: parseFloat(row.closing_balance || '0')
      }));
    } catch (error) {
      console.error('Error in getFinancialSummary:', error);
      throw error;
    }
  }

  async getVotersList(dto: VotersListDto) {
    const { division, branch, memberStatus = 'ACTIVE', sortBy = 'MBNO' } = dto;

    try {
      let query = this.memberMasterRepository
        .createQueryBuilder('m')
        .select([
          'm.mbno as memberNo',
          'CONCAT(m.prefix, \' \', m.f_name, \' \', COALESCE(m.m_name, \'\'), \' \', COALESCE(m.l_name, \'\')) as memberName',
          'm.desig as designation',
          'm.officeno as officeNo',
          'm.wingno as division',
          'm.basic_pay as basicPay',
          'm.memb_date as membershipDate',
          'm.isactive as isActive',
          'm.flg_retire as retireFlag'
        ]);

      // Apply status filter
      if (memberStatus === 'ACTIVE') {
        query = query.where('m.isactive = :status', { status: 'Y' });
        query = query.andWhere('m.flg_retire = :retire', { retire: 'N' });
      } else if (memberStatus === 'INACTIVE') {
        query = query.where('(m.isactive = :status OR m.flg_retire = :retire)', {
          status: 'N',
          retire: 'Y'
        });
      }

      // Apply division filter
      if (division && division !== '') {
        query = query.andWhere('m.wingno = :division', { division });
      }

      // Apply branch filter
      if (branch && branch !== '') {
        query = query.andWhere('CAST(m.officeno AS VARCHAR) = :branch', { branch });
      }

      // Apply sorting
      if (sortBy === 'MBNO') {
        query = query.orderBy('m.mbno', 'ASC');
      } else if (sortBy === 'NAME') {
        query = query.orderBy('m.f_name', 'ASC');
      } else if (sortBy === 'DOJ') {
        query = query.orderBy('m.memb_date', 'DESC');
      }

      const results = await query.getRawMany();

      return results.map(row => ({
        memberNo: row.memberno,
        memberName: row.membername,
        designation: row.designation,
        officeNo: row.officeno,
        division: row.division,
        basicPay: parseFloat(row.basicpay || '0'),
        membershipDate: row.membershipdate,
        isActive: row.isactive === 'Y',
        retireFlag: row.retireflag === 'Y'
      }));
    } catch (error) {
      console.error('Error in getVotersList:', error);
      throw error;
    }
  }

  async getDividendReport(dto: DividendReportDto) {
    const { wingName, officeName, financialYear, dividendRate = 10, sortBy = 'MBNO' } = dto;

    try {
      // Build query to fetch member share data
      let query = this.memberMasterRepository
        .createQueryBuilder('m')
        .leftJoin('annualstatement', 'a', 'a.accno = m.mbno')
        .select([
          'm.mbno as memberNo',
          'CONCAT(m.prefix, \' \', m.f_name, \' \', COALESCE(m.m_name, \'\'), \' \', COALESCE(m.l_name, \'\')) as memberName',
          'm.wingno as wing',
          'CAST(m.officeno AS VARCHAR) as office',
          'm.desig as designation',
          'COALESCE(a.cur_shareamt, 0) as shareAmount',
          `ROUND((COALESCE(a.cur_shareamt, 0) * ${dividendRate}) / 100, 2) as dividendAmount`
        ])
        .where('m.isactive = :status', { status: 'Y' })
        .andWhere('m.flg_retire = :retire', { retire: 'N' });

      // Apply wing filter
      if (wingName && wingName !== '') {
        query = query.andWhere('m.wingno = :wing', { wing: wingName });
      }

      // Apply office filter
      if (officeName && officeName !== '') {
        query = query.andWhere('CAST(m.officeno AS VARCHAR) = :office', { office: officeName });
      }

      // Apply sorting
      if (sortBy === 'MBNO') {
        query = query.orderBy('m.mbno', 'ASC');
      } else if (sortBy === 'NAME') {
        query = query.orderBy('m.f_name', 'ASC');
      } else if (sortBy === 'SHARE_AMT') {
        query = query.orderBy('a.cur_shareamt', 'DESC');
      }

      const results = await query.getRawMany();

      // Calculate totals
      const totalShareAmount = results.reduce((sum, row) => sum + parseFloat(row.shareamount || '0'), 0);
      const totalDividendAmount = results.reduce((sum, row) => sum + parseFloat(row.dividendamount || '0'), 0);

      return {
        data: results.map(row => ({
          memberNo: row.memberno,
          memberName: row.membername,
          wing: row.wing,
          office: row.office,
          designation: row.designation,
          shareAmount: parseFloat(row.shareamount || '0'),
          dividendAmount: parseFloat(row.dividendamount || '0')
        })),
        summary: {
          totalMembers: results.length,
          totalShareAmount,
          totalDividendAmount,
          dividendRate,
          financialYear: financialYear || 'Current Year'
        }
      };
    } catch (error) {
      console.error('Error in getDividendReport:', error);
      throw error;
    }
  }

  async getDividendPaid(dto: DividendPaidDto) {
    const { wingName, fromDate, toDate } = dto;

    try {
      // Query ledger for dividend payments
      // Assuming dividend payments are marked with trans_type='DR' (debit/payment)
      // and a specific code pattern or narration containing 'dividend'
      let query = this.ledgerRepository
        .createQueryBuilder('l')
        .leftJoin('member_master', 'm', 'm.mbno = l.mbno')
        .select([
          'l.trans_no as transactionNo',
          'l.trans_date as paymentDate',
          'l.mbno as memberNo',
          'CONCAT(m.prefix, \' \', m.f_name, \' \', COALESCE(m.m_name, \'\'), \' \', COALESCE(m.l_name, \'\')) as memberName',
          'm.wingno as wing',
          'm.desig as designation',
          'l.trans_amt as amount',
          'l.narration as narration',
          'l.receipt_vchr_no as voucherNo'
        ])
        .where('l.trans_type = :type', { type: 'DR' })
        .andWhere('LOWER(l.narration) LIKE :narration', { narration: '%dividend%' });

      // Apply date filters
      if (fromDate) {
        query = query.andWhere('l.trans_date >= :fromDate', { fromDate });
      }
      if (toDate) {
        query = query.andWhere('l.trans_date <= :toDate', { toDate });
      }

      // Apply wing filter
      if (wingName && wingName !== '') {
        query = query.andWhere('m.wingno = :wing', { wing: wingName });
      }

      query = query.orderBy('l.trans_date', 'DESC').addOrderBy('l.trans_no', 'DESC');

      const results = await query.getRawMany();

      // Calculate totals
      const totalAmount = results.reduce((sum, row) => sum + parseFloat(row.amount || '0'), 0);

      return {
        data: results.map(row => ({
          transactionNo: row.transactionno,
          paymentDate: row.paymentdate,
          memberNo: row.memberno,
          memberName: row.membername,
          wing: row.wing,
          designation: row.designation,
          amount: parseFloat(row.amount || '0'),
          narration: row.narration,
          voucherNo: row.voucherno
        })),
        summary: {
          totalPayments: results.length,
          totalAmount,
          fromDate: fromDate || 'N/A',
          toDate: toDate || 'N/A'
        }
      };
    } catch (error) {
      console.error('Error in getDividendPaid:', error);
      throw error;
    }
  }

  async getInterestList(dto: InterestListDto) {
    const { wingName, financialYear, accountType = 'ALL', sortBy = 'MBNO' } = dto;

    try {
      // Query member balances from annualstatement table
      // CD = Compulsory Deposit, MD = Monthly Deposit (thrift), Share = Share Capital
      let query = this.memberMasterRepository
        .createQueryBuilder('m')
        .leftJoin('annualstatement', 'a', 'a.accno = m.mbno')
        .select([
          'm.mbno as memberNo',
          'CONCAT(m.prefix, \' \', m.f_name, \' \', COALESCE(m.m_name, \'\'), \' \', COALESCE(m.l_name, \'\')) as memberName',
          'm.wingno as wing',
          'CAST(m.officeno AS VARCHAR) as office',
          'm.desig as designation',
          'COALESCE(a.cur_triftamt, 0) as cdBalance',       // CD (Compulsory Deposit)
          'COALESCE(a.cur_tfintrec, 0) as mdBalance',       // MD (Monthly Deposit/Thrift)
          'COALESCE(a.cur_shareamt, 0) as shareBalance',    // Share
          'ROUND((COALESCE(a.cur_triftamt, 0) * 8) / 100, 2) as cdInterest',    // 8% on CD
          'ROUND((COALESCE(a.cur_tfintrec, 0) * 6) / 100, 2) as mdInterest',    // 6% on MD
          'ROUND((COALESCE(a.cur_shareamt, 0) * 10) / 100, 2) as shareInterest' // 10% on Share
        ])
        .where('m.isactive = :status', { status: 'Y' })
        .andWhere('m.flg_retire = :retire', { retire: 'N' });

      // Apply wing filter
      if (wingName && wingName !== '') {
        query = query.andWhere('m.wingno = :wing', { wing: wingName });
      }

      // Apply account type filter
      if (accountType && accountType !== 'ALL') {
        if (accountType === 'CD') {
          query = query.andWhere('a.cur_triftamt > 0');
        } else if (accountType === 'MD') {
          query = query.andWhere('a.cur_tfintrec > 0');
        } else if (accountType === 'SHARE') {
          query = query.andWhere('a.cur_shareamt > 0');
        }
      }

      // Apply sorting
      if (sortBy === 'MBNO') {
        query = query.orderBy('m.mbno', 'ASC');
      } else if (sortBy === 'NAME') {
        query = query.orderBy('m.f_name', 'ASC');
      } else if (sortBy === 'BALANCE') {
        query = query.orderBy('(COALESCE(a.cur_triftamt, 0) + COALESCE(a.cur_tfintrec, 0) + COALESCE(a.cur_shareamt, 0))', 'DESC');
      }

      const results = await query.getRawMany();

      // Calculate totals
      const totalCDBalance = results.reduce((sum, row) => sum + parseFloat(row.cdbalance || '0'), 0);
      const totalMDBalance = results.reduce((sum, row) => sum + parseFloat(row.mdbalance || '0'), 0);
      const totalShareBalance = results.reduce((sum, row) => sum + parseFloat(row.sharebalance || '0'), 0);
      const totalCDInterest = results.reduce((sum, row) => sum + parseFloat(row.cdinterest || '0'), 0);
      const totalMDInterest = results.reduce((sum, row) => sum + parseFloat(row.mdinterest || '0'), 0);
      const totalShareInterest = results.reduce((sum, row) => sum + parseFloat(row.shareinterest || '0'), 0);

      return {
        data: results.map(row => ({
          memberNo: row.memberno,
          memberName: row.membername,
          wing: row.wing,
          office: row.office,
          designation: row.designation,
          cdBalance: parseFloat(row.cdbalance || '0'),
          mdBalance: parseFloat(row.mdbalance || '0'),
          shareBalance: parseFloat(row.sharebalance || '0'),
          cdInterest: parseFloat(row.cdinterest || '0'),
          mdInterest: parseFloat(row.mdinterest || '0'),
          shareInterest: parseFloat(row.shareinterest || '0'),
          totalInterest: parseFloat(row.cdinterest || '0') + parseFloat(row.mdinterest || '0') + parseFloat(row.shareinterest || '0')
        })),
        summary: {
          totalMembers: results.length,
          totalCDBalance,
          totalMDBalance,
          totalShareBalance,
          totalCDInterest,
          totalMDInterest,
          totalShareInterest,
          totalInterest: totalCDInterest + totalMDInterest + totalShareInterest,
          financialYear: financialYear || 'Current Year'
        }
      };
    } catch (error) {
      console.error('Error in getInterestList:', error);
      throw error;
    }
  }

  async findAll() {
    return { message: 'Report service - To be implemented' };
  }

  async getDividendWarrant(dto: DividendWarrantDto) {
    const { wingName, officeName, fromDate, uptoDate, memberNo, sortBy = 'MBNO' } = dto;
    const dividendRate = 10; // Default dividend rate 10%

    try {
      // Query member dividend data
      let query = this.memberMasterRepository
        .createQueryBuilder('m')
        .leftJoin('annualstatement', 'a', 'a.accno = m.mbno')
        .select([
          'm.mbno as memberNo',
          'CONCAT(m.prefix, \' \', m.f_name, \' \', COALESCE(m.m_name, \'\'), \' \', COALESCE(m.l_name, \'\')) as memberName',
          'm.wingno as wing',
          'CAST(m.officeno AS VARCHAR) as office',
          'm.desig as designation',
          'm.basic_pay as basicPay',
          'COALESCE(a.cur_shareamt, 0) as shareAmount',
          `ROUND((COALESCE(a.cur_shareamt, 0) * ${dividendRate}) / 100, 2) as dividendAmount`
        ])
        .where('m.isactive = :status', { status: 'Y' })
        .andWhere('m.flg_retire = :retire', { retire: 'N' })
        .andWhere('a.cur_shareamt > 0'); // Only members with shares

      // Apply filters
      if (wingName && wingName !== '') {
        query = query.andWhere('m.wingno = :wing', { wing: wingName });
      }

      if (officeName && officeName !== '') {
        query = query.andWhere('CAST(m.officeno AS VARCHAR) = :office', { office: officeName });
      }

      if (memberNo && memberNo !== '') {
        query = query.andWhere('m.mbno = :mbno', { mbno: memberNo });
      }

      // Date filters (if provided)
      if (fromDate) {
        query = query.andWhere('CURRENT_DATE >= :fromDate', { fromDate });
      }
      if (uptoDate) {
        query = query.andWhere('CURRENT_DATE <= :uptoDate', { uptoDate });
      }

      // Apply sorting
      if (sortBy === 'MBNO') {
        query = query.orderBy('m.mbno', 'ASC');
      } else if (sortBy === 'NAME') {
        query = query.orderBy('m.f_name', 'ASC');
      } else if (sortBy === 'AMOUNT') {
        query = query.orderBy('a.cur_shareamt', 'DESC');
      }

      const results = await query.getRawMany();

      // Calculate totals
      const totalAmount = results.reduce((sum, row) => sum + parseFloat(row.dividendamount || '0'), 0);

      // Generate warrant metadata
      const currentDate = new Date().toISOString().split('T')[0];

      return {
        data: results.map((row, index) => ({
          memberNo: row.memberno,
          memberName: row.membername,
          wing: row.wing,
          office: row.office,
          designation: row.designation,
          basicPay: parseFloat(row.basicpay || '0'),
          shareAmount: parseFloat(row.shareamount || '0'),
          dividendAmount: parseFloat(row.dividendamount || '0'),
          chequeNo: `CHQ${String(index + 1).padStart(6, '0')}`,
          bankName: 'State Bank of India',
          issueDate: currentDate
        })),
        summary: {
          totalWarrants: results.length,
          totalAmount,
          dividendRate,
          fromDate: fromDate || 'N/A',
          uptoDate: uptoDate || 'N/A'
        }
      };
    } catch (error) {
      console.error('Error in getDividendWarrant:', error);
      throw error;
    }
  }

  // Report Schedule Builder Methods
  async createReportSchedule(dto: CreateReportScheduleDto) {
    try {
      // Create header
      const header = this.scheduleHeaderRepository.create({
        schedule_name: dto.schedule_name,
        template_name: dto.template_name,
        report_type: dto.report_type || 'TRIAL',
      });
      
      const savedHeader = await this.scheduleHeaderRepository.save(header);

      // Create details
      const details = dto.details.map(detail => 
        this.scheduleDetailRepository.create({
          schedule_id: savedHeader.id,
          particulars: detail.particulars,
          code_from: detail.code_from,
          code_to: detail.code_to,
        })
      );

      await this.scheduleDetailRepository.save(details);

      return {
        success: true,
        scheduleId: savedHeader.id,
        message: 'Report schedule created successfully'
      };
    } catch (error) {
      console.error('Error creating report schedule:', error);
      throw error;
    }
  }

  async executeReportSchedule(dto: ExecuteReportScheduleDto) {
    const { scheduleId, fromDate, toDate, financialYearStart } = dto;

    try {
      // Fetch schedule details
      const details = await this.scheduleDetailRepository.find({
        where: { schedule_id: scheduleId },
        order: { id: 'ASC' }
      });

      if (details.length === 0) {
        throw new Error('No schedule details found for this schedule ID');
      }

      // Calculate totals for each line (Current vs Progressive)
      const lineItems = await Promise.all(
        details.map(async (detail) => {
          // Current Period: Receipts (CR) and Payments (DR)
          const currentResult = await this.ledgerRepository
            .createQueryBuilder('l')
            .select([
              'SUM(CASE WHEN l.trans_type = \'CR\' THEN l.trans_amt ELSE 0 END)', 'currentReceipts',
              'SUM(CASE WHEN l.trans_type = \'DR\' THEN l.trans_amt ELSE 0 END)', 'currentPayments'
            ])
            .where('l.code >= :codeFrom', { codeFrom: detail.code_from })
            .andWhere('l.code <= :codeTo', { codeTo: detail.code_to })
            .andWhere('l.trans_date >= :fromDate', { fromDate })
            .andWhere('l.trans_date <= :toDate', { toDate })
            .getRawOne();

          // Progressive (YTD): From financial year start to current toDate
          const progressiveResult = await this.ledgerRepository
            .createQueryBuilder('l')
            .select([
              'SUM(CASE WHEN l.trans_type = \'CR\' THEN l.trans_amt ELSE 0 END)', 'progressiveReceipts',
              'SUM(CASE WHEN l.trans_type = \'DR\' THEN l.trans_amt ELSE 0 END)', 'progressivePayments'
            ])
            .where('l.code >= :codeFrom', { codeFrom: detail.code_from })
            .andWhere('l.code <= :codeTo', { codeTo: detail.code_to })
            .andWhere('l.trans_date >= :financialYearStart', { financialYearStart })
            .andWhere('l.trans_date <= :toDate', { toDate })
            .getRawOne();

          // Calculate balances
          const currentReceipts = parseFloat(currentResult?.currentReceipts || '0');
          const currentPayments = parseFloat(currentResult?.currentPayments || '0');
          const currentBalance = currentReceipts - currentPayments;

          const progressiveReceipts = parseFloat(progressiveResult?.progressiveReceipts || '0');
          const progressivePayments = parseFloat(progressiveResult?.progressivePayments || '0');
          const progressiveBalance = progressiveReceipts - progressivePayments;

          return {
            particulars: detail.particulars,
            codeFrom: detail.code_from,
            codeTo: detail.code_to,
            current: {
              receipts: currentReceipts,
              payments: currentPayments,
              balance: currentBalance
            },
            progressive: {
              receipts: progressiveReceipts,
              payments: progressivePayments,
              balance: progressiveBalance
            }
          };
        })
      );

      // Calculate grand totals
      const grandTotals = lineItems.reduce(
        (totals, item) => ({
          currentReceipts: totals.currentReceipts + item.current.receipts,
          currentPayments: totals.currentPayments + item.current.payments,
          currentBalance: totals.currentBalance + item.current.balance,
          progressiveReceipts: totals.progressiveReceipts + item.progressive.receipts,
          progressivePayments: totals.progressivePayments + item.progressive.payments,
          progressiveBalance: totals.progressiveBalance + item.progressive.balance
        }),
        {
          currentReceipts: 0,
          currentPayments: 0,
          currentBalance: 0,
          progressiveReceipts: 0,
          progressivePayments: 0,
          progressiveBalance: 0
        }
      );

      return {
        scheduleId,
        fromDate,
        toDate,
        financialYearStart,
        lineItems,
        grandTotals
      };
    } catch (error) {
      console.error('Error executing report schedule:', error);
      throw error;
    }
  }

  async getAllReportSchedules(reportType?: string) {
    try {
      const where: any = {};
      if (reportType) {
        where.report_type = reportType;
      }

      const schedules = await this.scheduleHeaderRepository.find({
        where,
        order: { created_at: 'DESC' }
      });
      return schedules;
    } catch (error) {
      console.error('Error fetching report schedules:', error);
      throw error;
    }
  }
}
