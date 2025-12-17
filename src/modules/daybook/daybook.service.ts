import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactions } from '../cashbook/entities/transactions.entity';
import { Ledger } from '../cashbook/entities/ledger.entity';
import { MemberMaster } from '../member/entities/member-master.entity';
import { InterestMaster } from '../interest/entities/interest-master.entity';
import { 
  GetDayBookDto, 
  DayBookSummaryDto, 
  DayBookEntryDto,
  InterestCalculationDto,
  InterestPaymentDto 
} from './dto/daybook.dto';

@Injectable()
export class DayBookService {
  private readonly logger = new Logger(DayBookService.name);

  constructor(
    @InjectRepository(Transactions)
    private transactionsRepository: Repository<Transactions>,
    @InjectRepository(Ledger)
    private ledgerRepository: Repository<Ledger>,
    @InjectRepository(MemberMaster)
    private memberRepository: Repository<MemberMaster>,
    @InjectRepository(InterestMaster)
    private interestMasterRepository: Repository<InterestMaster>
  ) {}

  async getDayBookReport(dto: GetDayBookDto): Promise<DayBookSummaryDto> {
    try {
      const reportDate = new Date(dto.date);
      const startOfDay = new Date(reportDate);
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date(reportDate);
      endOfDay.setHours(23, 59, 59, 999);

      // Get transactions for the selected date
      let query = this.transactionsRepository
        .createQueryBuilder('t')
        .where('t.trans_date >= :startDate AND t.trans_date <= :endDate', {
          startDate: startOfDay,
          endDate: endOfDay
        });

      // Add filtering for SB (Savings Bank) transactions if specified
      if (dto.filterType === 'sb' || dto.filterType === 'savings') {
        // Filter for Savings Bank related transactions
        // Using A1001 (Cash in Hand) and other savings-related codes
        query = query.andWhere('(t.code = :savingsCode OR t.code LIKE :savingsPattern)', {
          savingsCode: 'A1001',
          savingsPattern: 'A%' // All asset codes that might be savings-related
        });
      }

      const transactions = await query
        .orderBy('t.trans_date', 'ASC')
        .addOrderBy('t.trans_no', 'ASC')
        .getMany();

      // Transform transactions to day book entries with member and head information
      const entries: DayBookEntryDto[] = await Promise.all(
        transactions.map(async (t) => {
          // Get member information
          let memberName = 'Unknown';
          if (t.mbno && t.mbno > 0) {
            try {
              const member = await this.memberRepository.findOne({
                where: { mbno: t.mbno?.toString() }
              });
              if (member) {
                memberName = `${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim();
              }
            } catch (error) {
              this.logger.warn(`Failed to fetch member ${t.mbno}:`, error.message);
            }
          }

          return {
            mbNo: t.mbno?.toString() || '0',
            memberName,
            voucherNo: t.receipt_vchr_no || '',
            transactionType: t.trans_type as 'CR' | 'DR',
            amount: this.parseMoneyAmount(t.trans_amt),
            headCode: t.code || '',
            headName: this.getHeadNameByCode(t.code || ''),
            narration: t.narration || '',
            username: t.username || '',
            transactionTime: t.trans_date
          };
        })
      );

      // Calculate opening balance (transactions before the selected date)
      const openingBalance = await this.calculateOpeningBalance(reportDate, dto.filterType);

      // Calculate totals
      const totalReceipts = entries
        .filter(e => e.transactionType === 'CR')
        .reduce((sum, e) => sum + e.amount, 0);
      
      const totalPayments = entries
        .filter(e => e.transactionType === 'DR')
        .reduce((sum, e) => sum + e.amount, 0);
      
      const netBalance = totalReceipts - totalPayments;
      const closingBalance = openingBalance + netBalance;

      return {
        date: dto.date,
        totalReceipts,
        totalPayments,
        netBalance,
        openingBalance,
        closingBalance,
        entries,
        totalTransactions: entries.length
      };

    } catch (error) {
      this.logger.error('Error generating day book report:', error);
      throw new Error('Failed to generate day book report');
    }
  }

  async getActiveMembersWithSavings(): Promise<any[]> {
    try {
      // Get active members who have savings account transactions
      const members = await this.memberRepository
        .createQueryBuilder('m')
        .select([
          'm.mbno',
          'm.f_name',
          'm.m_name', 
          'm.l_name',
          'm.isactive'
        ])
        .where('m.isactive = :status', { status: 'Y' })
        .orderBy('m.mbno', 'ASC')
        .getMany();

      return members.map(member => ({
        memberCode: member.mbno.toString(),
        memberName: `${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim(),
        status: member.isactive
      }));

    } catch (error) {
      this.logger.error('Error fetching active members:', error);
      throw new Error('Failed to fetch active members');
    }
  }

  async calculateMemberInterest(dto: InterestCalculationDto): Promise<any> {
    try {
      const fromDate = new Date(dto.fromDate);
      const toDate = new Date(dto.toDate);
      const memberCode = Number(dto.memberCode);

      // Get member's ledger entries for the period
      const ledgerEntries = await this.ledgerRepository
        .createQueryBuilder('l')
        .where('l.mbno = :memberCode', { memberCode })
        .andWhere('l.trans_date >= :fromDate AND l.trans_date <= :toDate', {
          fromDate,
          toDate
        })
        .andWhere('l.code LIKE :savingsCode', { savingsCode: 'A%' }) // Assuming savings codes start with 'A'
        .orderBy('l.trans_date', 'ASC')
        .getMany();

      // Calculate minimum monthly balance or average daily balance
      let runningBalance = 0;
      let totalDays = 0;
      let balanceSum = 0;
      let minBalance = 0;

      for (const entry of ledgerEntries) {
        const amount = this.parseMoneyAmount(entry.trans_amt.toString());
        if (entry.trans_type === 'CR') {
          runningBalance += amount;
        } else {
          runningBalance -= amount;
        }
        
        if (minBalance === 0 || runningBalance < minBalance) {
          minBalance = runningBalance;
        }
        
        balanceSum += runningBalance;
        totalDays++;
      }

      const averageBalance = totalDays > 0 ? balanceSum / totalDays : 0;
      const interestRate = dto.interestRate || await this.getCurrentInterestRate();
      
      // Calculate interest on minimum balance (conservative approach)
      const principalAmount = Math.max(0, minBalance);
      const daysDiff = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));
      const interestAmount = (principalAmount * interestRate * daysDiff) / (365 * 100);

      return {
        memberCode: dto.memberCode,
        fromDate: dto.fromDate,
        toDate: dto.toDate,
        daysDiff,
        minBalance,
        averageBalance,
        interestRate,
        principalAmount,
        interestAmount: Math.round(interestAmount * 100) / 100, // Round to 2 decimal places
        totalTransactions: ledgerEntries.length
      };

    } catch (error) {
      this.logger.error('Error calculating member interest:', error);
      throw new Error('Failed to calculate member interest');
    }
  }

  async payInterestToMember(dto: InterestPaymentDto): Promise<any> {
    try {
      const memberCode = Number(dto.memberCode);
      const paymentDate = new Date(dto.paymentDate);

      // Get next transaction number
      const nextTransNo = await this.getNextTransactionNumber();

      // Create transaction record for interest payment
      const transaction = this.transactionsRepository.create({
        trans_no: nextTransNo,
        trans_date: paymentDate,
        trans_type: 'CR',
        mbno: memberCode,
        acc_no: 0,
        acc_type: 'SB',
        trans_amt: dto.interestAmount.toString(),
        receipt_vchr_no: `INT${nextTransNo}`,
        vchr_type: 'R',
        modeofpay: 'C',
        cheq_no: '',
        cheq_amt: '0.00',
        cheq_date: null,
        bankname: '',
        pass_flag: 'N',
        cashier_flag: 'N',
        code: 'A1001', // Savings account code
        narration: dto.narration || 'Saving Interest',
        username: 'system',
        cust_bank_name: null
      });

      const savedTransaction = await this.transactionsRepository.save(transaction);

      // Create corresponding ledger entry
      const ledgerEntry = this.ledgerRepository.create({
        trans_no: nextTransNo,
        trans_date: paymentDate,
        trans_type: 'CR',
        code: 'A1001',
        mbno: memberCode,
        acc_no: 0,
        acc_type: 'SB',
        trans_amt: dto.interestAmount,
        receipt_vchr_no: `INT${nextTransNo}`,
        vchr_type: 'R',
        modeofpay: 'C',
        pl_balance: 0, // Will be calculated
        narration: dto.narration || 'Saving Interest',
        username: 'system',
        cust_bank_name: null
      });

      await this.ledgerRepository.save(ledgerEntry);

      return {
        transactionNo: nextTransNo,
        memberCode: dto.memberCode,
        interestAmount: dto.interestAmount,
        paymentDate: dto.paymentDate,
        voucherNo: `INT${nextTransNo}`,
        status: 'completed'
      };

    } catch (error) {
      this.logger.error('Error processing interest payment:', error);
      throw new Error('Failed to process interest payment');
    }
  }

  async getCurrentInterestRate(): Promise<number> {
    try {
      // Try to get from interestmaster table first
      const interestMaster = await this.interestMasterRepository
        .createQueryBuilder('im')
        .where('im.inttype = :type', { type: 'SB' }) // Savings Bank
        .andWhere('im.frdt <= :currentDate', { currentDate: new Date() })
        .andWhere('(im.todt IS NULL OR im.todt >= :currentDate)', { currentDate: new Date() })
        .orderBy('im.frdt', 'DESC')
        .getOne();

      if (interestMaster) {
        return Number(interestMaster.rate);
      }

      // Fallback to default rate
      return 4.0; // Default 4% if not found

    } catch (error) {
      this.logger.error('Error fetching current interest rate:', error);
      return 4.0; // Default fallback
    }
  }

  private parseMoneyAmount(moneyValue: string): number {
    if (!moneyValue) return 0;
    const cleanValue = moneyValue.toString().replace(/[$₹,?]/g, '').trim();
    return parseFloat(cleanValue) || 0;
  }

  private getHeadNameByCode(code: string): string {
    const codeMap: { [key: string]: string } = {
      'A1001': 'Savings Account',
      'A1002': 'Fixed Deposit',
      'A1003': 'Recurring Deposit',
      'L2001': 'Member Deposits',
      'I3001': 'Interest Income',
      'E4001': 'Interest Expense',
      'E4002': 'Administrative Expenses',
      'A1004': 'Cash in Hand',
      'A1005': 'Bank Account'
    };
    
    return codeMap[code] || `Head Code ${code}`;
  }

  private async calculateOpeningBalance(date: Date, filterType?: string): Promise<number> {
    try {
      let query = this.transactionsRepository
        .createQueryBuilder('t')
        .where('t.trans_date < :date', { date });

      // Add filtering for SB transactions if specified
      if (filterType === 'sb' || filterType === 'savings') {
        query = query.andWhere('(t.code = :savingsCode OR t.code LIKE :savingsPattern)', {
          savingsCode: 'A1001',
          savingsPattern: 'A%'
        });
      }

      const transactions = await query.getMany();

      const totalCredits = transactions
        .filter(t => t.trans_type === 'CR')
        .reduce((sum, t) => sum + this.parseMoneyAmount(t.trans_amt), 0);
      
      const totalDebits = transactions
        .filter(t => t.trans_type === 'DR')
        .reduce((sum, t) => sum + this.parseMoneyAmount(t.trans_amt), 0);

      return totalCredits - totalDebits;
    } catch (error) {
      this.logger.error('Error calculating opening balance:', error);
      return 0;
    }
  }

  private async getNextTransactionNumber(): Promise<number> {
    try {
      const result = await this.transactionsRepository
        .createQueryBuilder('t')
        .select('MAX(t.trans_no)', 'maxTransNo')
        .getRawOne();
      
      return (Number(result?.maxTransNo) || 0) + 1;
    } catch (error) {
      this.logger.error('Error getting next transaction number:', error);
      return 1;
    }
  }
}