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
  ) { }

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

  async findAll() {
    return { message: 'Report service - To be implemented' };
  }
}
