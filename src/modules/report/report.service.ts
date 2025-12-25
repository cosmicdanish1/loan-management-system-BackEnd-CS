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
import { JottingReportDto } from './dto/jotting-report.dto';
import { MemberBalanceRangeDto } from './dto/member-balance-range.dto';
import { SavingStatementDto } from './dto/saving-statement.dto';
import { RDStatementDto } from './dto/rd-statement.dto';
import { FDStatementDto } from './dto/fd-statement.dto';
import { MemberStatementDto } from './dto/member-statement.dto';
import { MemberProfileDto } from './dto/member-profile.dto';
import { InterestCertificateDto } from './dto/interest-certificate.dto';
import { LoanNilCertificateDto } from './dto/loan-nil-certificate.dto';
import { SuretyRegisterDto } from './dto/surety-register.dto';
import { DepositMaturityDto } from './dto/deposit-maturity.dto';
import { AccountClosingRegisterDto } from './dto/account-closing-register.dto';
import { FixedDepositCertificateDto } from './dto/fixed-deposit-certificate.dto';
import { ShareCertificateDto } from './dto/share-certificate.dto';
import { ShareWarrantDto } from './dto/share-warrant.dto';
import { RecurringDetailsDto } from './dto/recurring-details.dto';
import { RecoveryDetailsDto } from './dto/recovery-details.dto';
import { LoanContributionsRegisterDto } from './dto/loan-contributions-register.dto';
import { LienAccountInformationDto } from './dto/lien-account-information.dto';
import { AdHocReportsDto } from './dto/adhoc-reports.dto';
import { PassBookPrintingDto } from './dto/passbook-printing.dto';

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

  async diagnosticCheck() {
    const mem = await this.memberMasterRepository.query(`SELECT count(*)::text FROM members`);
    return mem;
  }


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
    
    // Helper function to parse money strings (e.g., "₹ 25,000.00" -> 25000)
    const parseMoneyString = (moneyStr: any): number => {
      if (!moneyStr) return 0;
      const str = moneyStr.toString();
      // Remove currency symbols, spaces, and commas, then parse
      const cleanStr = str.replace(/[₹$,\s?]/g, '');
      return parseFloat(cleanStr) || 0;
    };
    
    const ledgerData = transactions.map((trans, index) => {
      const isDebit = trans.trans_type === 'DR';
      const amount = parseMoneyString(trans.amount);
      const debit = isDebit ? amount : 0;
      const credit = !isDebit ? amount : 0;

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

    // Map loan category to head code based on actual database head codes
    const headCodeMap = {
      [LoanCategory.REGULAR]: 'A1002', // REGULAR LOAN
      [LoanCategory.SHORT_TERM]: 'A1047' // EMERGENCY LOAN (treating as short term)
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

    // Fetch transactions up to asOnDate for the specific member
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
      .andWhere('l.mbno = :memberCode', { memberCode: parseInt(memberCode) })
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
          'CAST(l.trans_amt AS numeric) as amount',
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

      // Helper function to parse money strings (e.g., "₹ 25,000.00" -> 25000)
      const parseMoneyString = (moneyStr: any): number => {
        if (!moneyStr) return 0;
        const str = moneyStr.toString();
        // Remove currency symbols, spaces, and commas, then parse
        const cleanStr = str.replace(/[₹$,\s]/g, '');
        return parseFloat(cleanStr) || 0;
      };

      // Calculate totals with proper money parsing
      const totalAmount = results.reduce((sum, row) => sum + parseMoneyString(row.amount), 0);

      return {
        data: results.map(row => ({
          transactionNo: row.transactionno,
          paymentDate: row.paymentdate,
          memberNo: row.memberno,
          memberName: row.membername,
          wing: row.wing,
          designation: row.designation,
          amount: parseMoneyString(row.amount),
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

  async getWingList() {
    const wings = await this.memberMasterRepository
      .createQueryBuilder('m')
      .select('DISTINCT m.wingno', 'wing')
      .where("m.wingno IS NOT NULL AND m.wingno != ''")
      .orderBy('m.wingno', 'ASC')
      .getRawMany();
    return wings.map(w => w.wing);
  }

  async getOfficeList() {
    const offices = await this.memberMasterRepository
      .createQueryBuilder('m')
      .select('DISTINCT m.officeno', 'office')
      .where("m.officeno IS NOT NULL")
      .orderBy('m.officeno', 'ASC')
      .getRawMany();
    return offices.map(o => o.office.toString());
  }

  async getJottingReport(dto: JottingReportDto) {
    const { headCode, asOnDate, wingName, officeName, sortBy = 'MBNO' } = dto;

    try {
      // Build query
      let query = this.memberMasterRepository
        .createQueryBuilder('m')
        .innerJoin('ledger', 'l', 'm.mbno = l.mbno') // Use inner join to only include members with transactions
        .select([
          'm.mbno as mbno',
          'CONCAT(m.prefix, \' \', m.f_name, \' \', COALESCE(m.m_name, \'\'), \' \', COALESCE(m.l_name, \'\')) as memberName',
          'm.wingno as wing',
          'CAST(m.officeno AS VARCHAR) as office',
          'SUM(CASE WHEN l.trans_type = \'CR\' THEN l.trans_amt ELSE 0 END) as totalCredit',
          'SUM(CASE WHEN l.trans_type = \'DR\' THEN l.trans_amt ELSE 0 END) as totalDebit'
        ])
        .where('l.code = :headCode', { headCode })
        .andWhere('l.trans_date <= :asOnDate', { asOnDate });

      // Apply Wing Filter
      if (wingName && wingName !== '') {
        query = query.andWhere('m.wingno = :wingName', { wingName });
      }

      // Apply Office Filter
      if (officeName && officeName !== '') {
        query = query.andWhere('CAST(m.officeno AS VARCHAR) = :officeName', { officeName });
      }

      // Group By
      query = query.groupBy('m.mbno, m.prefix, m.f_name, m.m_name, m.l_name, m.wingno, m.officeno');

      // Sorting
      if (sortBy === 'MBNO') {
        query = query.orderBy('m.mbno', 'ASC');
      } else if (sortBy === 'NAME') {
        query = query.orderBy('m.f_name', 'ASC');
      }

      const results = await query.getRawMany();

      // Post-processing to calculate balance and filter zeros
      const reportData = results.map(row => {
        const totalCredit = parseFloat(row.totalcredit || '0');
        const totalDebit = parseFloat(row.totaldebit || '0');
        // Generic approach: Credit - Debit.
        // If result is positive: Net Credit (Savings/Deposit balance)
        // If result is negative: Net Debit (Loan outstanding)
        const balance = totalCredit - totalDebit;

        return {
          memberNo: row.mbno,
          memberName: row.membername,
          wing: row.wing,
          office: row.office,
          balance: balance
        };
      }).filter(item => Math.abs(item.balance) > 0.01); // Exclude zero balances

      return reportData;

    } catch (error) {
      console.error('Error in getJottingReport:', error);
      throw error;
    }
  }

  async getMemberBalanceRangeReport(dto: MemberBalanceRangeDto) {
    const { fromAccountNo, toAccountNo } = dto;

    try {
      const results = await this.memberMasterRepository
        .createQueryBuilder('m')
        .leftJoin('ledger', 'l', 'm.mbno = l.mbno')
        .select([
          'm.mbno as memberNo',
          'CONCAT(m.prefix, \' \', m.f_name, \' \', COALESCE(m.m_name, \'\'), \' \', COALESCE(m.l_name, \'\')) as memberName',
          'SUM(CASE WHEN l.trans_type = \'CR\' THEN l.trans_amt ELSE 0 END) as totalCredit',
          'SUM(CASE WHEN l.trans_type = \'DR\' THEN l.trans_amt ELSE 0 END) as totalDebit'
        ])
        .where('m.mbno BETWEEN :fromAccountNo AND :toAccountNo', { fromAccountNo, toAccountNo })
        .groupBy('m.mbno, m.prefix, m.f_name, m.m_name, m.l_name')
        .orderBy('m.mbno', 'ASC')
        .getRawMany();

      return results.map(row => {
        const credit = parseFloat(row.totalcredit || '0');
        const debit = parseFloat(row.totaldebit || '0');
        return {
          memberNo: row.memberno,
          memberName: row.membername,
          currentBalance: credit - debit
        };
      });

    } catch (error) {
      console.error('Error in getMemberBalanceRangeReport:', error);
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
              'SUM(CASE WHEN l.trans_type = \'CR\' THEN CAST(l.trans_amt AS numeric) ELSE 0 END)', 'currentReceipts',
              'SUM(CASE WHEN l.trans_type = \'DR\' THEN CAST(l.trans_amt AS numeric) ELSE 0 END)', 'currentPayments'
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
              'SUM(CASE WHEN l.trans_type = \'CR\' THEN CAST(l.trans_amt AS numeric) ELSE 0 END)', 'progressiveReceipts',
              'SUM(CASE WHEN l.trans_type = \'DR\' THEN CAST(l.trans_amt AS numeric) ELSE 0 END)', 'progressivePayments'
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
  async getSavingStatement(dto: SavingStatementDto) {
    const { memberNo, fromDate, toDate, headCode = 'S001' } = dto;

    // 1. Validate Member
    const member = await this.memberMasterRepository.findOne({
      where: { mbno: memberNo }
    });

    if (!member) {
      throw new Error(`Member with number ${memberNo} not found`);
    }

    const memberName = `${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim();

    // 2. Calculate Opening Balance (everything before fromDate)
    const openingBalResult = await this.ledgerRepository
      .createQueryBuilder('l')
      .select('SUM(CASE WHEN l.trans_type = \'CR\' THEN l.trans_amt::numeric ELSE -(l.trans_amt::numeric) END)', 'balance')
      .where('l.mbno = :mbno', { mbno: parseInt(memberNo) })
      .andWhere('l.code = :headCode', { headCode })
      .andWhere('l.trans_date < :fromDate', { fromDate })
      .getRawOne();

    const openingBalance = parseFloat(openingBalResult?.balance) || 0;

    // 3. Fetch Transactions
    const transactions = await this.ledgerRepository
      .createQueryBuilder('l')
      .where('l.mbno = :mbno', { mbno: parseInt(memberNo) })
      .andWhere('l.code = :headCode', { headCode })
      .andWhere('l.trans_date BETWEEN :fromDate AND :toDate', { fromDate, toDate })
      .orderBy('l.trans_date', 'ASC')
      .addOrderBy('l.trans_no', 'ASC')
      .getMany();

    // 4. Calculate Running Balance
    let currentBalance = openingBalance;
    const items = transactions.map(t => {
      const amount = parseFloat(t.trans_amt.toString());
      const debit = t.trans_type === 'DR' ? amount : 0;
      const credit = t.trans_type === 'CR' ? amount : 0;

      currentBalance += (credit - debit);

      return {
        key: t.trans_no.toString(),
        date: t.trans_date,
        voucherNo: t.receipt_vchr_no,
        particulars: t.narration,
        withdrawal: debit,
        deposit: credit,
        balance: currentBalance
      };
    });

    return {
      memberNo,
      memberName,
      openingBalance,
      transactions: items,
      closingBalance: currentBalance
    };
  }
  async getRDStatement(dto: RDStatementDto) {
    const { memberNo, fromDate, toDate, headCode = 'RD01' } = dto;

    // 1. Validate Member
    const member = await this.memberMasterRepository.findOne({
      where: { mbno: memberNo }
    });

    if (!member) {
      throw new Error(`Member with number ${memberNo} not found`);
    }

    const memberName = `${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim();

    // 2. Calculate Opening Balance (everything before fromDate)
    const openingBalResult = await this.ledgerRepository
      .createQueryBuilder('l')
      .select('SUM(CASE WHEN l.trans_type = \'CR\' THEN l.trans_amt::numeric ELSE -(l.trans_amt::numeric) END)', 'balance')
      .where('l.mbno = :mbno', { mbno: parseInt(memberNo) })
      .andWhere('l.code = :headCode', { headCode })
      .andWhere('l.trans_date < :fromDate', { fromDate })
      .getRawOne();

    const openingBalance = parseFloat(openingBalResult?.balance) || 0;

    // 3. Fetch Transactions
    const transactions = await this.ledgerRepository
      .createQueryBuilder('l')
      .where('l.mbno = :mbno', { mbno: parseInt(memberNo) })
      .andWhere('l.code = :headCode', { headCode })
      .andWhere('l.trans_date BETWEEN :fromDate AND :toDate', { fromDate, toDate })
      .orderBy('l.trans_date', 'ASC')
      .addOrderBy('l.trans_no', 'ASC')
      .getMany();

    // 4. Calculate Running Balance
    let currentBalance = openingBalance;
    const items = transactions.map(t => {
      const amount = parseFloat(t.trans_amt.toString());
      const debit = t.trans_type === 'DR' ? amount : 0;
      const credit = t.trans_type === 'CR' ? amount : 0;

      currentBalance += (credit - debit);

      return {
        key: t.trans_no.toString(),
        date: t.trans_date,
        voucherNo: t.receipt_vchr_no,
        particulars: t.narration,
        withdrawal: debit,
        deposit: credit,
        balance: currentBalance
      };
    });

    return {
      memberNo,
      memberName,
      openingBalance,
      transactions: items,
      closingBalance: currentBalance
    };
  }

  async getFDStatement(dto: FDStatementDto) {
    const { memberNo, fromDate, toDate, headCode = 'FD01' } = dto;

    try {
      // 1. First, get the member's FD account details from fdmaster
      const fdAccountQuery = `
        SELECT 
          f.mbno as "memberNo",
          CONCAT(f.prefix, ' ', f.f_name, ' ', COALESCE(f.m_name, ''), ' ', COALESCE(f.l_name, '')) as "memberName",
          f.account_number::text as "accountNo",
          f.certno as "certificateNo",
          f.fdamount::numeric as "principalAmount",
          f.rate::numeric as "interestRate",
          f.depdate as "openDate",
          f.matdate as "maturityDate",
          f.matamount::numeric as "maturityAmount",
          f.status as "status"
        FROM fdmaster f
        WHERE f.mbno = $1
          AND f.fdrdflag = 'F' -- Fixed Deposit only
        ORDER BY f.depdate DESC
        LIMIT 1
      `;

      const fdAccounts = await this.memberMasterRepository.query(fdAccountQuery, [parseInt(memberNo)]);

      if (!fdAccounts || fdAccounts.length === 0) {
        throw new Error(`No Fixed Deposit account found for member ${memberNo}`);
      }

      const fdAccount = fdAccounts[0];

      // 2. Calculate Opening Balance (everything before fromDate)
      const openingBalResult = await this.ledgerRepository
        .createQueryBuilder('l')
        .select('SUM(CASE WHEN l.trans_type = \'CR\' THEN l.trans_amt::numeric ELSE -(l.trans_amt::numeric) END)', 'balance')
        .where('l.mbno = :mbno', { mbno: parseInt(memberNo) })
        .andWhere('l.code = :headCode', { headCode })
        .andWhere('l.trans_date < :fromDate', { fromDate })
        .getRawOne();

      const openingBalance = parseFloat(openingBalResult?.balance) || 0;

      // 3. Fetch Transactions for the period
      const transactions = await this.ledgerRepository
        .createQueryBuilder('l')
        .where('l.mbno = :mbno', { mbno: parseInt(memberNo) })
        .andWhere('l.code = :headCode', { headCode })
        .andWhere('l.trans_date BETWEEN :fromDate AND :toDate', { fromDate, toDate })
        .orderBy('l.trans_date', 'ASC')
        .addOrderBy('l.trans_no', 'ASC')
        .getMany();

      // 4. Calculate Running Balance
      let currentBalance = openingBalance;
      const items = transactions.map(t => {
        const amount = parseFloat(t.trans_amt.toString());
        const debit = t.trans_type === 'DR' ? amount : 0;
        const credit = t.trans_type === 'CR' ? amount : 0;

        currentBalance += (credit - debit);

        return {
          key: t.trans_no.toString(),
          date: t.trans_date,
          voucherNo: t.receipt_vchr_no,
          particulars: t.narration,
          withdrawal: debit,
          deposit: credit,
          balance: currentBalance
        };
      });

      return {
        memberNo: fdAccount.memberNo,
        memberName: fdAccount.memberName,
        accountNo: fdAccount.accountNo,
        certificateNo: fdAccount.certificateNo,
        principalAmount: parseFloat(fdAccount.principalAmount || '0'),
        interestRate: parseFloat(fdAccount.interestRate || '0'),
        openDate: fdAccount.openDate,
        maturityDate: fdAccount.maturityDate,
        maturityAmount: parseFloat(fdAccount.maturityAmount || '0'),
        status: fdAccount.status,
        openingBalance,
        transactions: items,
        closingBalance: currentBalance
      };

    } catch (error) {
      console.error('Error in getFDStatement:', error);
      throw error;
    }
  }

  async getMemberStatement(dto: MemberStatementDto) {
    const { memberNo, fromDate, toDate } = dto;

    // 1. Validate Member
    const member = await this.memberMasterRepository.findOne({
      where: { mbno: memberNo }
    });

    if (!member) {
      throw new Error(`Member with number ${memberNo} not found`);
    }

    const memberName = `${member.prefix || ''} ${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim();

    // 2. Get Summary of Balances per Head
    const summaryResults = await this.ledgerRepository
      .createQueryBuilder('l')
      .leftJoin(HeadMaster, 'h', 'h.code = l.code')
      .select([
        'l.code as "headCode"',
        'h.head_name as "headName"',
        'SUM(CASE WHEN l.trans_type = \'CR\' THEN l.trans_amt::numeric ELSE -(l.trans_amt::numeric) END) as balance'
      ])
      .where('l.mbno = :mbno', { mbno: parseInt(memberNo) })
      .groupBy('l.code, h.head_name')
      .getRawMany();

    const summary = summaryResults.map(s => ({
      headCode: s.headCode,
      headName: s.headName || 'Unknown Head',
      balance: parseFloat(s.balance) || 0
    })).filter(s => Math.abs(s.balance) > 0.01);

    // 3. Get Detailed Consolidated Ledger
    const transactions = await this.ledgerRepository
      .createQueryBuilder('l')
      .leftJoin(HeadMaster, 'h', 'h.code = l.code')
      .select([
        'l.trans_no as "transNo"',
        'l.trans_date as "date"',
        'l.code as "headCode"',
        'h.head_name as "headName"',
        'l.receipt_vchr_no as "voucherNo"',
        'l.narration as "narration"',
        'l.trans_type as "type"',
        'l.trans_amt as "amount"'
      ])
      .where('l.mbno = :mbno', { mbno: parseInt(memberNo) })
      .andWhere('l.trans_date BETWEEN :fromDate AND :toDate', { fromDate, toDate })
      .orderBy('l.trans_date', 'ASC')
      .addOrderBy('l.trans_no', 'ASC')
      .getRawMany();

    const items = transactions.map(t => {
      const amount = parseFloat(t.amount);
      return {
        key: t.transNo.toString(),
        date: t.date,
        headCode: t.headCode,
        headName: t.headName || 'Unknown',
        voucherNo: t.voucherNo,
        narration: t.narration,
        withdrawal: t.type === 'DR' ? amount : 0,
        deposit: t.type === 'CR' ? amount : 0
      };
    });

    return {
      memberNo,
      memberName,
      summary,
      transactions: items
    };
  }

  async getMemberProfile(dto: MemberProfileDto) {
    const { memberNo } = dto;

    // Use a robust raw query to fetch member details, matching the columns provided in user instructions
    // but adjusting for actual known columns like 'mbno' instead of 'member_code'
    const results = await this.memberMasterRepository.query(`
      SELECT 
        m.mbno as "memberNo",
        m.prefix as "prefix",
        m.f_name as "firstName",
        m.m_name as "middleName",
        m.l_name as "lastName",
        m.dob as "dob",
        m.memb_date as "doj",
        m.present_address as "address",
        m.pfno as "pfNo",
        m.flg_retire as "status",
        m.wingno as "wingNo",
        m.officeno as "officeNo",
        m.basic_pay as "basicPay",
        m.gross_salary as "grossSalary",
        m.nominee_name as "nomineeName",
        m.nominee_relation as "nomineeRelation",
        m.nominee_address as "nomineeAddress",
        m.isactive as "isActive",
        w.wname as "wingName",
        d.name as "officeName"
      FROM member_master m
      LEFT JOIN wingmast w ON m.wingno = w.wingno
      LEFT JOIN division_master d ON m.wingno = d.wingno AND m.officeno = d.officeno
      WHERE m.mbno = $1
    `, [parseInt(memberNo)]);

    if (!results || results.length === 0) {
      throw new Error(`Member with number ${memberNo} not found`);
    }

    const member = results[0];

    // Calculate dynamic totals for Share and Thrift if they aren't static in member_master
    const financialSummary = await this.ledgerRepository.query(`
      SELECT 
        SUM(CASE WHEN code = 'S001' THEN (CASE WHEN trans_type = 'CR' THEN trans_amt::numeric ELSE -(trans_amt::numeric) END) ELSE 0 END) as "thriftBalance",
        SUM(CASE WHEN code = 'SH01' THEN (CASE WHEN trans_type = 'CR' THEN trans_amt::numeric ELSE -(trans_amt::numeric) END) ELSE 0 END) as "shareCapital"
      FROM ledger
      WHERE mbno = $1
    `, [parseInt(memberNo)]);

    const finance = financialSummary[0] || { thriftBalance: 0, shareCapital: 0 };

    return {
      ...member,
      fullName: `${member.prefix || ''} ${member.firstName || ''} ${member.middleName || ''} ${member.lastName || ''}`.trim(),
      shareCapital: parseFloat(finance.shareCapital || 0),
      thriftBalance: parseFloat(finance.thriftBalance || 0),
      statusLabel: member.status === 'Y' || member.isActive === 'Y' ? 'Active' : 'Regular'
    };
  }

  async getInterestCertificate(dto: InterestCertificateDto) {
    const { memberNo, fromDate, toDate } = dto;

    // Fetch member details for certificate header
    const memberResults = await this.memberMasterRepository.query(`
      SELECT mbno, f_name, m_name, l_name, prefix, present_address
      FROM member_master
      WHERE mbno = $1
    `, [parseInt(memberNo) || 0]);

    if (!memberResults || memberResults.length === 0) {
      throw new Error(`Member ${memberNo} not found`);
    }

    const member = memberResults[0];

    // Interest is typically registered under specific heads (e.g., 'INT01' for loan interest paid)
    // We sum up CR transactions for interest heads (from member's perspective, CR in ledger means society received interest)
    const interestResults = await this.ledgerRepository.query(`
      SELECT 
        l.code as "headCode",
        h.head_name as "headName",
        SUM(l.trans_amt::numeric) as "totalInterest"
      FROM ledger l
      JOIN headmaster h ON l.code = h.code
      WHERE l.mbno = $1 
        AND l.trans_date BETWEEN $2 AND $3
        AND h.head_name ILIKE '%Interest%'
        AND l.trans_type = 'CR'
      GROUP BY l.code, h.head_name
    `, [parseInt(memberNo) || 0, fromDate, toDate]);

    return {
      memberNo: member.mbno,
      memberName: `${member.prefix || ''} ${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim(),
      address: member.present_address,
      period: { fromDate, toDate },
      interests: interestResults.map(i => ({
        ...i,
        totalInterest: parseFloat(i.totalInterest || 0)
      }))
    };
  }

  async getLoanNilCertificate(dto: LoanNilCertificateDto) {
    const { memberNo } = dto;

    // Fetch member details
    const memberResults = await this.memberMasterRepository.query(`
      SELECT mbno, f_name, m_name, l_name, prefix, present_address, memb_date
      FROM member_master
      WHERE mbno = $1
    `, [parseInt(memberNo) || 0]);

    if (!memberResults || memberResults.length === 0) {
      throw new Error(`Member ${memberNo} not found`);
    }

    const member = memberResults[0];

    // Check balances of all loan accounts
    // Usually loan head codes start with 'L' or specific patterns. 
    // We check for any account where DR != CR (unbalanced)
    const loanBalances = await this.ledgerRepository.query(`
      SELECT 
        l.code as "headCode",
        h.head_name as "headName",
        SUM(CASE WHEN l.trans_type = 'DR' THEN l.trans_amt::numeric ELSE -(l.trans_amt::numeric) END) as "balance"
      FROM ledger l
      JOIN headmaster h ON l.code = h.code
      WHERE l.mbno = $1
        AND (h.head_name ILIKE '%Loan%' OR h.head_name ILIKE '%Advance%')
      GROUP BY l.code, h.head_name
      HAVING ABS(SUM(CASE WHEN l.trans_type = 'DR' THEN l.trans_amt::numeric ELSE -(l.trans_amt::numeric) END)) > 0.01
    `, [parseInt(memberNo) || 0]);

    return {
      memberNo: member.mbno,
      memberName: `${member.prefix || ''} ${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim(),
      address: member.present_address,
      joiningDate: member.memb_date,
      isNil: loanBalances.length === 0,
      outstandingLoans: loanBalances.map(l => ({
        ...l,
        balance: parseFloat(l.balance || 0)
      }))
    };
  }

  async getSuretyRegister(dto: SuretyRegisterDto) {
    const { memberFrom, memberTo, loanType } = dto;

    // The user provided the logic:
    // loan_surety (links guarantors to loans)
    // loan_master (loan details)
    // member_master (names)

    const query = `
      SELECT 
        -- 1. Surety Details
        ls.surety_member_code AS "suretyMbno",
        (m_surety.f_name || ' ' || COALESCE(m_surety.m_name, '') || ' ' || m_surety.l_name) AS "suretyName",
        
        -- 2. Loan Details
        lm.loancaseno AS "loanNo",
        lm.loantype AS "loanType",
        lm.loan_amt::numeric AS "loanAmount",
        lm.balance::numeric AS "outstandingBalance",
        
        -- 3. Borrower Details
        lm.mbno AS "mbno",
        (m_borrower.f_name || ' ' || COALESCE(m_borrower.m_name, '') || ' ' || m_borrower.l_name) AS "memberName"

      FROM 
        loan_surety ls
      JOIN 
        loan_master lm ON ls.loancaseno::numeric = lm.loancaseno::numeric
      JOIN 
        member_master m_surety ON ls.surety_member_code::numeric = m_surety.mbno::numeric
      JOIN 
        member_master m_borrower ON lm.mbno::numeric = m_borrower.mbno::numeric
      WHERE 
        ls.surety_member_code::numeric BETWEEN $1 AND $2
        ${loanType ? 'AND lm.loantype = $3' : ''}
      ORDER BY 
        ls.surety_member_code
    `;

    const params = [parseInt(memberFrom) || 0, parseInt(memberTo) || 0];
    if (loanType) params.push(loanType as any);

    const results = await this.memberMasterRepository.query(query, params);

    return results.map((row, index) => ({
      key: index.toString(),
      ...row,
      loanAmount: parseFloat(row.loanAmount || 0),
      outstandingBalance: parseFloat(row.outstandingBalance || 0)
    }));
  }

  async getDepositMaturity(dto: DepositMaturityDto) {
    const { fromDate, toDate, depositType } = dto;

    const query = `
      SELECT 
        d.account_number::text AS "accountNo", 
        d.mbno::text AS "memberNo", 
        (m.f_name || ' ' || COALESCE(m.m_name, '') || ' ' || m.l_name) AS "memberName", 
        COALESCE(d.fdrdflag, 'FD') AS "depositType", 
        COALESCE(d.fdamount, 0)::numeric AS "amount", 
        d.matdate AS "dueDate", 
        COALESCE(d.matamount, 0)::numeric AS "maturityAmount",
        COALESCE(d.rate, 0)::numeric AS "interestRate"
      FROM fdmaster d
      INNER JOIN member_master m ON d.mbno::numeric = m.mbno::numeric
      WHERE d.matdate BETWEEN $1 AND $2
      AND ($3 = 'All' OR $3 IS NULL OR d.fdrdflag = $3)
      ORDER BY d.matdate ASC;
    `;

    // Format dates to YYYY-MM-DD
    const fDate = new Date(fromDate).toISOString().split('T')[0];
    const tDate = new Date(toDate).toISOString().split('T')[0];

    // Normalize depositType for 'All'
    const typeFilter = depositType === 'All' ? null : depositType;

    const results = await this.memberMasterRepository.query(query, [fDate, tDate, typeFilter]);

    return results.map((row, index) => ({
      key: index.toString(),
      ...row,
      amount: parseFloat(row.amount || 0),
      maturityAmount: parseFloat(row.maturityAmount || 0),
      interestRate: parseFloat(row.interestRate || 0)
    }));
  }

  async getAccountClosingRegister(dto: AccountClosingRegisterDto) {
    const { accountType, month, year } = dto;

    try {
      let query = '';
      let params: any[] = [month, year];

      // Determine which tables to query based on account type
      if (!accountType || accountType === 'ALL') {
        // Query all account types - FD, RD, and Loans
        query = `
          -- Fixed Deposits
          SELECT 
            f.mbno as "memberCode",
            CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
            f.account_number::text as "accountNo",
            'FD' as "accountType",
            f.statusdate as "closingDate",
            f.matamount::numeric as "finalAmount",
            'Fixed Deposit' as "description"
          FROM fdmaster f
          INNER JOIN member_master m ON f.mbno = m.mbno
          WHERE f.status = '1' -- Assuming '1' means closed
            AND EXTRACT(MONTH FROM f.statusdate) = $1
            AND EXTRACT(YEAR FROM f.statusdate) = $2
            AND f.statusdate IS NOT NULL
            AND f.fdrdflag = 'F' -- FD flag

          UNION ALL

          -- Recurring Deposits (RD entries in fdmaster with fdrdflag = 'R')
          SELECT 
            f.mbno as "memberCode",
            CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
            f.account_number::text as "accountNo",
            'RD' as "accountType",
            f.statusdate as "closingDate",
            f.matamount::numeric as "finalAmount",
            'Recurring Deposit' as "description"
          FROM fdmaster f
          INNER JOIN member_master m ON f.mbno = m.mbno
          WHERE f.status = '1' -- Closed
            AND f.fdrdflag = 'R' -- RD flag
            AND EXTRACT(MONTH FROM f.statusdate) = $1
            AND EXTRACT(YEAR FROM f.statusdate) = $2
            AND f.statusdate IS NOT NULL

          UNION ALL

          -- Loans (assuming loans are closed when balance = 0)
          SELECT 
            l.mbno as "memberCode",
            CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
            l.loancaseno::text as "accountNo",
            l.loantype as "accountType",
            l.payment_date as "closingDate", -- Using payment_date as placeholder
            l.loan_amt::numeric as "finalAmount",
            CONCAT(l.loantype, ' Loan') as "description"
          FROM loan_master l
          INNER JOIN member_master m ON l.mbno = m.mbno
          WHERE l.balance::numeric = 0 -- Assuming 0 balance means closed
            AND EXTRACT(MONTH FROM l.payment_date) = $1
            AND EXTRACT(YEAR FROM l.payment_date) = $2

          ORDER BY "closingDate" ASC, "memberCode" ASC
        `;
      } else if (accountType === 'FD') {
        // Fixed Deposits only
        query = `
          SELECT 
            f.mbno as "memberCode",
            CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
            f.account_number::text as "accountNo",
            'FD' as "accountType",
            f.statusdate as "closingDate",
            f.matamount::numeric as "finalAmount",
            'Fixed Deposit' as "description"
          FROM fdmaster f
          INNER JOIN member_master m ON f.mbno = m.mbno
          WHERE f.status = '1' -- Closed
            AND f.fdrdflag = 'F' -- FD flag
            AND EXTRACT(MONTH FROM f.statusdate) = $1
            AND EXTRACT(YEAR FROM f.statusdate) = $2
            AND f.statusdate IS NOT NULL
          ORDER BY f.statusdate ASC, f.mbno ASC
        `;
      } else if (accountType === 'RD') {
        // Recurring Deposits only
        query = `
          SELECT 
            f.mbno as "memberCode",
            CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
            f.account_number::text as "accountNo",
            'RD' as "accountType",
            f.statusdate as "closingDate",
            f.matamount::numeric as "finalAmount",
            'Recurring Deposit' as "description"
          FROM fdmaster f
          INNER JOIN member_master m ON f.mbno = m.mbno
          WHERE f.status = '1' -- Closed
            AND f.fdrdflag = 'R' -- RD flag
            AND EXTRACT(MONTH FROM f.statusdate) = $1
            AND EXTRACT(YEAR FROM f.statusdate) = $2
            AND f.statusdate IS NOT NULL
          ORDER BY f.statusdate ASC, f.mbno ASC
        `;
      } else {
        // Specific loan type
        query = `
          SELECT 
            l.mbno as "memberCode",
            CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
            l.loancaseno::text as "accountNo",
            l.loantype as "accountType",
            l.payment_date as "closingDate",
            l.loan_amt::numeric as "finalAmount",
            CONCAT(l.loantype, ' Loan') as "description"
          FROM loan_master l
          INNER JOIN member_master m ON l.mbno = m.mbno
          WHERE l.balance::numeric = 0
            AND l.loantype = $3
            AND EXTRACT(MONTH FROM l.payment_date) = $1
            AND EXTRACT(YEAR FROM l.payment_date) = $2
          ORDER BY l.payment_date ASC, l.mbno ASC
        `;
        params.push(accountType);
      }

      const results = await this.memberMasterRepository.query(query, params);

      return results.map((row, index) => ({
        key: index.toString(),
        memberCode: row.memberCode,
        memberName: row.memberName,
        accountNo: row.accountNo,
        accountType: row.accountType,
        closingDate: row.closingDate,
        finalAmount: parseFloat(row.finalAmount || '0'),
        description: row.description
      }));

    } catch (error) {
      console.error('Error in getAccountClosingRegister:', error);
      throw error;
    }
  }

  async getFixedDepositCertificate(dto: FixedDepositCertificateDto) {
    const { memberNo, certificateNo } = dto;

    try {
      // Build query to fetch FD certificate data
      let query = `
        SELECT 
          f.mbno as "memberNo",
          CONCAT(f.prefix, ' ', f.f_name, ' ', COALESCE(f.m_name, ''), ' ', COALESCE(f.l_name, '')) as "memberName",
          m.present_address as "address",
          f.account_number::text as "accountNo",
          f.certno as "certificateNo",
          f.fdamount::numeric as "depositAmount",
          f.rate::numeric as "interestRate",
          f.depperiod::numeric as "tenure",
          f.depdate as "openDate",
          f.matdate as "maturityDate",
          f.matamount::numeric as "maturityAmount",
          f.nominee as "nominee",
          f.nrelation as "nomineeRelation",
          f.naddr as "nomineeAddress"
        FROM fdmaster f
        INNER JOIN member_master m ON f.mbno = m.mbno
        WHERE f.mbno = $1
          AND f.fdrdflag = 'F' -- Ensure it's a Fixed Deposit
          AND f.status != '1' -- Exclude closed accounts
      `;

      const params: any[] = [parseInt(memberNo)];

      // Add certificate number filter if provided
      if (certificateNo && certificateNo.trim() !== '') {
        query += ' AND f.certno = $2';
        params.push(certificateNo.trim());
      }

      query += ' ORDER BY f.depdate DESC';

      const results = await this.memberMasterRepository.query(query, params);

      if (!results || results.length === 0) {
        throw new Error(`No Fixed Deposit found for member ${memberNo}${certificateNo ? ` with certificate ${certificateNo}` : ''}`);
      }

      // Return the first (most recent) FD if multiple exist
      const fdData = results[0];

      return {
        memberNo: fdData.memberNo,
        memberName: fdData.memberName,
        address: fdData.address,
        accountNo: fdData.accountNo,
        certificateNo: fdData.certificateNo,
        depositAmount: parseFloat(fdData.depositAmount || '0'),
        interestRate: parseFloat(fdData.interestRate || '0'),
        tenure: parseInt(fdData.tenure || '0'),
        openDate: fdData.openDate,
        maturityDate: fdData.maturityDate,
        maturityAmount: parseFloat(fdData.maturityAmount || '0'),
        nominee: fdData.nominee || 'Not Specified',
        nomineeRelation: fdData.nomineeRelation || '',
        nomineeAddress: fdData.nomineeAddress || ''
      };

    } catch (error) {
      console.error('Error in getFixedDepositCertificate:', error);
      throw error;
    }
  }

  async getShareCertificate(dto: ShareCertificateDto) {
    const { memberNo, shareFrom, shareTo, certificateNo } = dto;

    try {
      // Since there's no dedicated share_master table, we'll use the annualstatement and member_master tables
      // to generate a share certificate based on current share holdings
      let query = `
        SELECT 
          m.mbno as "memberNo",
          CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
          m.present_address as "address",
          m.memb_date as "membershipDate",
          COALESCE(a.cur_shareamt, 0)::numeric as "totalShareAmount",
          COALESCE(a.op_shareamt, 0)::numeric as "openingShareAmount",
          -- Generate certificate details (since no share_master table exists)
          CONCAT('SC-', LPAD(m.mbno::text, 6, '0')) as "certificateNo",
          CURRENT_DATE as "issueDate",
          -- Calculate share details based on face value (assuming Rs. 10 per share)
          CASE 
            WHEN COALESCE(a.cur_shareamt, 0) > 0 
            THEN (COALESCE(a.cur_shareamt, 0) / 10)::integer 
            ELSE 0 
          END as "totalShares",
          10 as "faceValuePerShare",
          -- Generate share range (using modulo to avoid integer overflow with large member numbers)
          CASE 
            WHEN COALESCE(a.cur_shareamt, 0) > 0 
            THEN ((m.mbno % 100000) * 100 + 1)::integer 
            ELSE 0 
          END as "shareFrom",
          CASE 
            WHEN COALESCE(a.cur_shareamt, 0) > 0 
            THEN ((m.mbno % 100000) * 100 + (COALESCE(a.cur_shareamt, 0) / 10)::integer)::integer 
            ELSE 0 
          END as "shareTo"
        FROM member_master m
        LEFT JOIN annualstatement a ON m.mbno = a.accno
        WHERE m.mbno = $1
          AND m.isactive = 'Y'
      `;

      const params: any[] = [parseInt(memberNo)];

      // Add certificate number filter if provided
      if (certificateNo && certificateNo.trim() !== '') {
        query += ' AND CONCAT(\'SC-\', LPAD(m.mbno::text, 6, \'0\')) = $2';
        params.push(certificateNo.trim());
      }

      const results = await this.memberMasterRepository.query(query, params);

      if (!results || results.length === 0) {
        throw new Error(`No Share Certificate data found for member ${memberNo}${certificateNo ? ` with certificate ${certificateNo}` : ''}`);
      }

      const shareData = results[0];

      // Check if member has any shares
      if (shareData.totalShareAmount <= 0) {
        throw new Error(`Member ${memberNo} has no share holdings`);
      }

      // Apply share range filters if provided
      let filteredShareFrom = shareData.shareFrom;
      let filteredShareTo = shareData.shareTo;
      let filteredTotalShares = shareData.totalShares;

      if (shareFrom && parseInt(shareFrom) > 0) {
        filteredShareFrom = Math.max(parseInt(shareFrom), shareData.shareFrom);
      }

      if (shareTo && parseInt(shareTo) > 0) {
        filteredShareTo = Math.min(parseInt(shareTo), shareData.shareTo);
      }

      // Recalculate total shares based on filtered range
      if (filteredShareFrom <= filteredShareTo) {
        filteredTotalShares = filteredShareTo - filteredShareFrom + 1;
      } else {
        throw new Error(`Invalid share range: From ${filteredShareFrom} to ${filteredShareTo}`);
      }

      return {
        memberNo: shareData.memberNo,
        memberName: shareData.memberName,
        address: shareData.address || 'Address not available',
        membershipDate: shareData.membershipDate,
        certificateNo: shareData.certificateNo,
        issueDate: shareData.issueDate,
        shareFrom: filteredShareFrom,
        shareTo: filteredShareTo,
        totalShares: filteredTotalShares,
        faceValuePerShare: shareData.faceValuePerShare,
        totalValue: filteredTotalShares * shareData.faceValuePerShare,
        totalShareAmount: parseFloat(shareData.totalShareAmount || '0'),
        openingShareAmount: parseFloat(shareData.openingShareAmount || '0')
      };

    } catch (error) {
      console.error('Error in getShareCertificate:', error);
      throw error;
    }
  }

  async getRecurringDetails(dto: RecurringDetailsDto) {
    const { memberNo } = dto;

    try {
      // Query RD (Recurring Deposit) accounts from fdmaster table
      let query = `
        SELECT 
          f.mbno as "memberNo",
          CONCAT(f.prefix, ' ', f.f_name, ' ', COALESCE(f.m_name, ''), ' ', COALESCE(f.l_name, '')) as "memberName",
          m.present_address as "address",
          f.account_number::text as "accountNo",
          f.certno as "certificateNo",
          f.fdamount::numeric as "monthlyAmount",
          f.rate::numeric as "interestRate",
          f.depperiod::numeric as "tenure",
          f.depdate as "openDate",
          f.matdate as "maturityDate",
          f.matamount::numeric as "maturityAmount",
          f.nominee as "nominee",
          f.nrelation as "nomineeRelation",
          f.status as "status",
          f.minbal::numeric as "minimumBalance",
          -- Calculate installments paid (simplified)
          CASE 
            WHEN f.depdate IS NOT NULL AND CURRENT_DATE >= f.depdate
            THEN EXTRACT(MONTH FROM AGE(CURRENT_DATE, f.depdate))::integer
            ELSE 0
          END as "installmentsPaid"
        FROM fdmaster f
        INNER JOIN member_master m ON f.mbno = m.mbno
        WHERE f.mbno = $1
          AND f.fdrdflag = 'R' -- Recurring Deposit
          AND f.status != '1' -- Exclude closed accounts
        ORDER BY f.depdate DESC
      `;

      const params: any[] = [parseInt(memberNo)];
      const results = await this.memberMasterRepository.query(query, params);

      if (!results || results.length === 0) {
        throw new Error(`No Recurring Deposit accounts found for member ${memberNo}`);
      }

      return results.map(rd => ({
        memberNo: rd.memberNo,
        memberName: rd.memberName,
        address: rd.address || 'Address not available',
        accountNo: rd.accountNo,
        certificateNo: rd.certificateNo,
        monthlyAmount: parseFloat(rd.monthlyAmount || '0'),
        interestRate: parseFloat(rd.interestRate || '0'),
        tenure: parseInt(rd.tenure || '0'),
        openDate: rd.openDate,
        maturityDate: rd.maturityDate,
        maturityAmount: parseFloat(rd.maturityAmount || '0'),
        nominee: rd.nominee || 'Not Specified',
        nomineeRelation: rd.nomineeRelation || '',
        status: rd.status === '0' ? 'Active' : 'Closed',
        minimumBalance: parseFloat(rd.minimumBalance || '0'),
        installmentsPaid: parseInt(rd.installmentsPaid || '0')
      }));

    } catch (error) {
      console.error('Error in getRecurringDetails:', error);
      throw error;
    }
  }

  async getRecoveryDetails(dto: RecoveryDetailsDto) {
    const { memberNo, month, year } = dto;

    try {
      // Query recovery/demand details for the specified member and period
      let query = `
        SELECT 
          d.mbno as "memberNo",
          CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
          m.present_address as "address",
          d.demand_for_month as "demandMonth",
          d.demand_for_year as "demandYear",
          d.totaldemand::numeric as "totalDemand",
          d.rln_amount::numeric as "regularLoanAmount",
          d.eln_amount::numeric as "emergencyLoanAmount",
          d.aln_amount::numeric as "advanceLoanAmount",
          d.mln_amount::numeric as "miscLoanAmount",
          d.rd_amount::numeric as "rdAmount",
          d.md_amount::numeric as "mdAmount",
          d.cd_amount::numeric as "cdAmount",
          d.shr_amount::numeric as "shareAmount",
          d.bankcharge::numeric as "bankCharges",
          d.others::numeric as "otherCharges",
          d.balance_for_month::numeric as "balanceForMonth",
          d.dmnd_gnrt_date as "demandGeneratedDate",
          d.dmnd_post_date as "demandPostedDate",
          d.demand_posted as "demandPosted",
          d.passflag as "passFlag"
        FROM demand_master d
        INNER JOIN member_master m ON d.mbno = m.mbno
        WHERE d.mbno = $1
          AND d.demand_for_month = $2
          AND d.demand_for_year = $3
        ORDER BY d.dmnd_gnrt_date DESC
      `;

      // Convert month name to number
      const monthMap: { [key: string]: number } = {
        'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
        'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
      };

      const monthNumber = monthMap[month.toUpperCase()] || 1;
      const params: any[] = [parseInt(memberNo), monthNumber, parseInt(year)];
      
      const results = await this.memberMasterRepository.query(query, params);

      if (!results || results.length === 0) {
        throw new Error(`No recovery details found for member ${memberNo} for ${month} ${year}`);
      }

      const recoveryData = results[0];

      return {
        memberNo: recoveryData.memberNo,
        memberName: recoveryData.memberName,
        address: recoveryData.address || 'Address not available',
        demandMonth: recoveryData.demandMonth,
        demandYear: recoveryData.demandYear,
        period: `${month} ${year}`,
        totalDemand: parseFloat(recoveryData.totalDemand || '0'),
        loanRecoveries: {
          regularLoan: parseFloat(recoveryData.regularLoanAmount || '0'),
          emergencyLoan: parseFloat(recoveryData.emergencyLoanAmount || '0'),
          advanceLoan: parseFloat(recoveryData.advanceLoanAmount || '0'),
          miscLoan: parseFloat(recoveryData.miscLoanAmount || '0')
        },
        depositRecoveries: {
          recurringDeposit: parseFloat(recoveryData.rdAmount || '0'),
          monthlyDeposit: parseFloat(recoveryData.mdAmount || '0'),
          compulsoryDeposit: parseFloat(recoveryData.cdAmount || '0'),
          shareAmount: parseFloat(recoveryData.shareAmount || '0')
        },
        charges: {
          bankCharges: parseFloat(recoveryData.bankCharges || '0'),
          otherCharges: parseFloat(recoveryData.otherCharges || '0')
        },
        balanceForMonth: parseFloat(recoveryData.balanceForMonth || '0'),
        demandGeneratedDate: recoveryData.demandGeneratedDate,
        demandPostedDate: recoveryData.demandPostedDate,
        status: recoveryData.demandPosted === 'Y' ? 'Posted' : 'Pending'
      };

    } catch (error) {
      console.error('Error in getRecoveryDetails:', error);
      throw error;
    }
  }

  async getLoanContributionsRegister(dto: LoanContributionsRegisterDto) {
    const { memberNo, fromDate, toDate } = dto;

    try {
      // Query loan contributions/transactions for the specified member and date range
      let query = `
        SELECT 
          l.mbno as "memberNo",
          CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
          m.present_address as "address",
          lm.loantype as "loanType",
          lm.loancaseno as "loanCaseNo",
          lm.loan_amt::numeric as "loanAmount",
          lm.payment_date as "disbursementDate",
          lm.rate::numeric as "interestRate",
          lm.no_of_instal as "numberOfInstallments",
          lm.instal_amt::numeric as "installmentAmount",
          lm.balance::numeric as "outstandingBalance",
          lm.purpose as "purpose",
          l.trans_date as "transactionDate",
          l.trans_type as "transactionType",
          l.trans_amt::numeric as "transactionAmount",
          l.narration as "narration",
          l.receipt_vchr_no as "voucherNo"
        FROM ledger l
        INNER JOIN member_master m ON l.mbno = m.mbno
        LEFT JOIN loan_master lm ON l.mbno = lm.mbno
        WHERE l.mbno = $1
          AND l.trans_date >= $2::date
          AND l.trans_date <= $3::date
          AND (l.code LIKE '%LN%' OR l.narration ILIKE '%loan%' OR l.narration ILIKE '%contribution%')
        ORDER BY l.trans_date DESC, l.trans_no DESC
      `;

      const params: any[] = [parseInt(memberNo), fromDate, toDate];
      const results = await this.memberMasterRepository.query(query, params);

      if (!results || results.length === 0) {
        throw new Error(`No loan contribution records found for member ${memberNo} between ${fromDate} and ${toDate}`);
      }

      // Group transactions by loan type
      const groupedData = results.reduce((acc, record) => {
        const key = `${record.loanType || 'MISC'}-${record.loanCaseNo || 'N/A'}`;
        if (!acc[key]) {
          acc[key] = {
            loanDetails: {
              loanType: record.loanType || 'Miscellaneous',
              loanCaseNo: record.loanCaseNo || 'N/A',
              loanAmount: parseFloat(record.loanAmount || '0'),
              disbursementDate: record.disbursementDate,
              interestRate: parseFloat(record.interestRate || '0'),
              numberOfInstallments: parseInt(record.numberOfInstallments || '0'),
              installmentAmount: parseFloat(record.installmentAmount || '0'),
              outstandingBalance: parseFloat(record.outstandingBalance || '0'),
              purpose: record.purpose || 'Not specified'
            },
            transactions: []
          };
        }
        
        acc[key].transactions.push({
          transactionDate: record.transactionDate,
          transactionType: record.transactionType,
          transactionAmount: parseFloat(record.transactionAmount || '0'),
          narration: record.narration || '',
          voucherNo: record.voucherNo || ''
        });
        
        return acc;
      }, {});

      return {
        memberNo: results[0].memberNo,
        memberName: results[0].memberName,
        address: results[0].address || 'Address not available',
        fromDate,
        toDate,
        loanContributions: Object.values(groupedData),
        totalTransactions: results.length,
        summary: {
          totalDebits: results.filter(r => r.transactionType === 'DR').reduce((sum, r) => sum + parseFloat(r.transactionAmount || '0'), 0),
          totalCredits: results.filter(r => r.transactionType === 'CR').reduce((sum, r) => sum + parseFloat(r.transactionAmount || '0'), 0)
        }
      };

    } catch (error) {
      console.error('Error in getLoanContributionsRegister:', error);
      throw error;
    }
  }

  async getLienAccountInformation(dto: LienAccountInformationDto) {
    try {
      // Query lien account information from fdrdlienmaster and related tables
      let query = `
        SELECT 
          l.mbno as "memberNo",
          CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
          m.present_address as "address",
          l.loancaseno as "loanCaseNo",
          l.fdrd_accountnumber as "fdrdAccountNumber",
          l.fromdate as "lienFromDate",
          l.username as "createdBy",
          -- FD/RD Account Details
          f.certno as "certificateNo",
          f.fdamount::numeric as "accountAmount",
          f.rate::numeric as "interestRate",
          f.depdate as "depositDate",
          f.matdate as "maturityDate",
          f.fdrdflag as "accountType",
          f.status as "accountStatus",
          -- Loan Details
          lm.loan_amt::numeric as "loanAmount",
          lm.balance::numeric as "loanBalance",
          lm.payment_date as "loanDate",
          lm.loantype as "loanType"
        FROM fdrdlienmaster l
        INNER JOIN member_master m ON l.mbno = m.mbno
        LEFT JOIN fdmaster f ON l.mbno = f.mbno AND l.fdrd_accountnumber = f.account_number
        LEFT JOIN loan_master lm ON l.loancaseno = lm.loancaseno AND l.mbno = lm.mbno
        ORDER BY l.fromdate DESC, l.mbno ASC
      `;

      const results = await this.memberMasterRepository.query(query);

      if (!results || results.length === 0) {
        throw new Error('No lien account information found');
      }

      return results.map(lien => ({
        memberNo: lien.memberNo,
        memberName: lien.memberName,
        address: lien.address || 'Address not available',
        loanCaseNo: lien.loanCaseNo,
        fdrdAccountNumber: lien.fdrdAccountNumber,
        lienFromDate: lien.lienFromDate,
        createdBy: lien.createdBy || 'System',
        accountDetails: {
          certificateNo: lien.certificateNo,
          accountAmount: parseFloat(lien.accountAmount || '0'),
          interestRate: parseFloat(lien.interestRate || '0'),
          depositDate: lien.depositDate,
          maturityDate: lien.maturityDate,
          accountType: lien.accountType === 'F' ? 'Fixed Deposit' : lien.accountType === 'R' ? 'Recurring Deposit' : 'Savings',
          accountStatus: lien.accountStatus === '0' ? 'Active' : 'Closed'
        },
        loanDetails: {
          loanAmount: parseFloat(lien.loanAmount || '0'),
          loanBalance: parseFloat(lien.loanBalance || '0'),
          loanDate: lien.loanDate,
          loanType: lien.loanType || 'Not specified'
        }
      }));

    } catch (error) {
      console.error('Error in getLienAccountInformation:', error);
      throw error;
    }
  }

  async getAdHocReports(dto: AdHocReportsDto) {
    const { reportType, fromDate, toDate, memberNo, accountType, customQuery } = dto;

    try {
      let query = '';
      let params: any[] = [];

      switch (reportType) {
        case 'member_wise':
          query = `
            SELECT 
              m.mbno as "memberNo",
              CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
              m.present_address as "address",
              m.desig as "designation",
              m.dept_name as "department",
              m.memb_date as "membershipDate",
              m.isactive as "status",
              -- Account Balances
              COALESCE(a.cur_shareamt, 0)::numeric as "shareBalance",
              COALESCE(a.cur_triftamt, 0)::numeric as "cdBalance",
              COALESCE(a.cur_tfintrec, 0)::numeric as "mdBalance",
              -- Loan Balance
              COALESCE(SUM(lm.balance), 0)::numeric as "loanBalance"
            FROM member_master m
            LEFT JOIN annualstatement a ON m.mbno = a.accno
            LEFT JOIN loan_master lm ON m.mbno = lm.mbno
            WHERE m.isactive = 'Y'
          `;
          
          if (memberNo) {
            query += ' AND m.mbno = $1';
            params.push(parseInt(memberNo));
          }
          
          query += ' GROUP BY m.mbno, m.prefix, m.f_name, m.m_name, m.l_name, m.present_address, m.desig, m.dept_name, m.memb_date, m.isactive, a.cur_shareamt, a.cur_triftamt, a.cur_tfintrec ORDER BY m.mbno';
          break;

        case 'account_wise':
          query = `
            SELECT 
              f.mbno as "memberNo",
              CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
              f.account_number::text as "accountNo",
              f.certno as "certificateNo",
              CASE 
                WHEN f.fdrdflag = 'F' THEN 'Fixed Deposit'
                WHEN f.fdrdflag = 'R' THEN 'Recurring Deposit'
                ELSE 'Savings'
              END as "accountType",
              f.fdamount::numeric as "amount",
              f.rate::numeric as "interestRate",
              f.depdate as "openDate",
              f.matdate as "maturityDate",
              f.status as "status"
            FROM fdmaster f
            INNER JOIN member_master m ON f.mbno = m.mbno
            WHERE 1=1
          `;
          
          if (accountType) {
            query += ' AND f.fdrdflag = $' + (params.length + 1);
            params.push(accountType);
          }
          
          if (fromDate && toDate) {
            query += ' AND f.depdate >= $' + (params.length + 1) + ' AND f.depdate <= $' + (params.length + 2);
            params.push(fromDate, toDate);
          }
          
          query += ' ORDER BY f.depdate DESC';
          break;

        case 'transaction_wise':
          query = `
            SELECT 
              l.trans_date as "transactionDate",
              l.mbno as "memberNo",
              CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
              l.trans_type as "transactionType",
              l.trans_amt::numeric as "amount",
              l.narration as "narration",
              l.receipt_vchr_no as "voucherNo",
              h.head_name as "headName"
            FROM ledger l
            INNER JOIN member_master m ON l.mbno = m.mbno
            LEFT JOIN headmaster h ON l.code = h.code
            WHERE 1=1
          `;
          
          if (fromDate && toDate) {
            query += ' AND l.trans_date >= $' + (params.length + 1) + ' AND l.trans_date <= $' + (params.length + 2);
            params.push(fromDate, toDate);
          }
          
          if (memberNo) {
            query += ' AND l.mbno = $' + (params.length + 1);
            params.push(parseInt(memberNo));
          }
          
          query += ' ORDER BY l.trans_date DESC, l.trans_no DESC LIMIT 1000';
          break;

        case 'balance_summary':
          query = `
            SELECT 
              'Share Capital' as "accountType",
              COUNT(*) as "totalAccounts",
              SUM(COALESCE(a.cur_shareamt, 0))::numeric as "totalBalance"
            FROM annualstatement a
            WHERE COALESCE(a.cur_shareamt, 0) > 0
            UNION ALL
            SELECT 
              'Compulsory Deposit' as "accountType",
              COUNT(*) as "totalAccounts",
              SUM(COALESCE(a.cur_triftamt, 0))::numeric as "totalBalance"
            FROM annualstatement a
            WHERE COALESCE(a.cur_triftamt, 0) > 0
            UNION ALL
            SELECT 
              'Monthly Deposit' as "accountType",
              COUNT(*) as "totalAccounts",
              SUM(COALESCE(a.cur_tfintrec, 0))::numeric as "totalBalance"
            FROM annualstatement a
            WHERE COALESCE(a.cur_tfintrec, 0) > 0
            UNION ALL
            SELECT 
              'Fixed Deposits' as "accountType",
              COUNT(*) as "totalAccounts",
              SUM(f.fdamount)::numeric as "totalBalance"
            FROM fdmaster f
            WHERE f.fdrdflag = 'F' AND f.status = '0'
            UNION ALL
            SELECT 
              'Recurring Deposits' as "accountType",
              COUNT(*) as "totalAccounts",
              SUM(f.fdamount)::numeric as "totalBalance"
            FROM fdmaster f
            WHERE f.fdrdflag = 'R' AND f.status = '0'
          `;
          break;

        case 'loan_summary':
          query = `
            SELECT 
              lm.loantype as "loanType",
              COUNT(*) as "totalLoans",
              SUM(lm.loan_amt)::numeric as "totalLoanAmount",
              SUM(lm.balance)::numeric as "outstandingBalance",
              AVG(lm.rate)::numeric as "averageRate"
            FROM loan_master lm
            WHERE lm.balance > 0
            GROUP BY lm.loantype
            ORDER BY SUM(lm.balance) DESC
          `;
          break;

        case 'deposit_summary':
          query = `
            SELECT 
              CASE 
                WHEN f.fdrdflag = 'F' THEN 'Fixed Deposit'
                WHEN f.fdrdflag = 'R' THEN 'Recurring Deposit'
                ELSE 'Other'
              END as "depositType",
              COUNT(*) as "totalAccounts",
              SUM(f.fdamount)::numeric as "totalAmount",
              AVG(f.rate)::numeric as "averageRate",
              MIN(f.depdate) as "earliestDate",
              MAX(f.matdate) as "latestMaturity"
            FROM fdmaster f
            WHERE f.status = '0'
            GROUP BY f.fdrdflag
            ORDER BY SUM(f.fdamount) DESC
          `;
          break;

        case 'custom':
          if (!customQuery || customQuery.trim() === '') {
            throw new Error('Custom query is required for custom report type');
          }
          
          // Basic security check - only allow SELECT statements
          const trimmedQuery = customQuery.trim().toUpperCase();
          if (!trimmedQuery.startsWith('SELECT')) {
            throw new Error('Only SELECT queries are allowed for custom reports');
          }
          
          // Prevent dangerous operations
          const dangerousKeywords = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'CREATE', 'TRUNCATE'];
          for (const keyword of dangerousKeywords) {
            if (trimmedQuery.includes(keyword)) {
              throw new Error(`${keyword} operations are not allowed in custom queries`);
            }
          }
          
          query = customQuery;
          break;

        default:
          throw new Error(`Unsupported report type: ${reportType}`);
      }

      const results = await this.memberMasterRepository.query(query, params);

      return {
        reportType,
        fromDate,
        toDate,
        memberNo,
        accountType,
        totalRecords: results.length,
        data: results,
        generatedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error('Error in getAdHocReports:', error);
      throw error;
    }
  }

  async getPassBookPrinting(dto: PassBookPrintingDto) {
    const { memberNo, accountNo, accountType, fromDate, toDate, includeZeroBalance } = dto;

    try {
      // Get member details
      const memberQuery = `
        SELECT 
          m.mbno as "memberNo",
          CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
          m.present_address as "address",
          m.memb_date as "membershipDate"
        FROM member_master m
        WHERE m.mbno = $1
      `;

      const memberResult = await this.memberMasterRepository.query(memberQuery, [parseInt(memberNo)]);

      if (!memberResult || memberResult.length === 0) {
        throw new Error(`Member ${memberNo} not found`);
      }

      const memberData = memberResult[0];

      // Get account details based on account type or account number
      let accountQuery = '';
      let accountParams: any[] = [parseInt(memberNo)];

      if (accountNo) {
        // Specific account number provided
        accountQuery = `
          SELECT 
            f.account_number::text as "accountNo",
            f.certno as "certificateNo",
            CASE 
              WHEN f.fdrdflag = 'F' THEN 'Fixed Deposit'
              WHEN f.fdrdflag = 'R' THEN 'Recurring Deposit'
              ELSE 'Savings'
            END as "accountType",
            f.fdamount::numeric as "currentBalance",
            f.rate::numeric as "interestRate",
            f.depdate as "openDate",
            f.matdate as "maturityDate",
            f.status as "status"
          FROM fdmaster f
          WHERE f.mbno = $1 AND f.account_number = $2
        `;
        accountParams.push(parseInt(accountNo));
      } else if (accountType) {
        // Account type filter
        accountQuery = `
          SELECT 
            f.account_number::text as "accountNo",
            f.certno as "certificateNo",
            CASE 
              WHEN f.fdrdflag = 'F' THEN 'Fixed Deposit'
              WHEN f.fdrdflag = 'R' THEN 'Recurring Deposit'
              ELSE 'Savings'
            END as "accountType",
            f.fdamount::numeric as "currentBalance",
            f.rate::numeric as "interestRate",
            f.depdate as "openDate",
            f.matdate as "maturityDate",
            f.status as "status"
          FROM fdmaster f
          WHERE f.mbno = $1 AND f.fdrdflag = $2
          ORDER BY f.depdate DESC
        `;
        accountParams.push(accountType);
      } else {
        // All accounts for the member
        accountQuery = `
          SELECT 
            f.account_number::text as "accountNo",
            f.certno as "certificateNo",
            CASE 
              WHEN f.fdrdflag = 'F' THEN 'Fixed Deposit'
              WHEN f.fdrdflag = 'R' THEN 'Recurring Deposit'
              ELSE 'Savings'
            END as "accountType",
            f.fdamount::numeric as "currentBalance",
            f.rate::numeric as "interestRate",
            f.depdate as "openDate",
            f.matdate as "maturityDate",
            f.status as "status"
          FROM fdmaster f
          WHERE f.mbno = $1
          ORDER BY f.depdate DESC
        `;
      }

      const accountResults = await this.memberMasterRepository.query(accountQuery, accountParams);

      if (!accountResults || accountResults.length === 0) {
        throw new Error(`No accounts found for member ${memberNo}`);
      }

      // Get transactions for the accounts
      const accountNumbers = accountResults.map(acc => acc.accountNo);
      let transactionQuery = `
        SELECT 
          l.trans_date as "transactionDate",
          l.trans_type as "transactionType",
          l.trans_amt::numeric as "amount",
          l.narration as "narration",
          l.receipt_vchr_no as "voucherNo",
          l.acc_no as "accountNo",
          h.head_name as "headName"
        FROM ledger l
        LEFT JOIN headmaster h ON l.code = h.code
        WHERE l.mbno = $1
      `;

      let transactionParams: any[] = [parseInt(memberNo)];

      if (accountNo) {
        transactionQuery += ' AND l.acc_no = $2';
        transactionParams.push(parseInt(accountNo));
      }

      if (fromDate && toDate) {
        const paramIndex = transactionParams.length;
        transactionQuery += ` AND l.trans_date >= $${paramIndex + 1} AND l.trans_date <= $${paramIndex + 2}`;
        transactionParams.push(fromDate, toDate);
      }

      if (!includeZeroBalance) {
        transactionQuery += ' AND l.trans_amt > 0';
      }

      transactionQuery += ' ORDER BY l.trans_date ASC, l.trans_no ASC';

      const transactionResults = await this.memberMasterRepository.query(transactionQuery, transactionParams);

      // Calculate running balance for each account
      const accountsWithTransactions = accountResults.map(account => {
        const accountTransactions = transactionResults.filter(t => 
          t.accountNo?.toString() === account.accountNo || 
          (!t.accountNo && accountResults.length === 1) // If no account number in transaction, assume single account
        );

        let runningBalance = 0;
        const processedTransactions = accountTransactions.map(transaction => {
          const amount = parseFloat(transaction.amount || '0');
          if (transaction.transactionType === 'CR') {
            runningBalance += amount;
          } else {
            runningBalance -= amount;
          }

          return {
            ...transaction,
            amount,
            runningBalance
          };
        });

        return {
          ...account,
          transactions: processedTransactions,
          transactionCount: processedTransactions.length,
          totalCredits: processedTransactions
            .filter(t => t.transactionType === 'CR')
            .reduce((sum, t) => sum + t.amount, 0),
          totalDebits: processedTransactions
            .filter(t => t.transactionType === 'DR')
            .reduce((sum, t) => sum + t.amount, 0)
        };
      });

      return {
        memberDetails: memberData,
        accounts: accountsWithTransactions,
        fromDate,
        toDate,
        includeZeroBalance,
        totalAccounts: accountsWithTransactions.length,
        totalTransactions: transactionResults.length,
        generatedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error('Error in getPassBookPrinting:', error);
      throw error;
    }
  }
}
