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
  ) { }

  async getDayBookReport(dto: GetDayBookDto): Promise<DayBookSummaryDto> {
    try {
      // `ledger.trans_date` is a timestamp without time zone. Compare it to
      // local calendar-day strings and use an exclusive next-day boundary so
      // JavaScript/server timezone conversion cannot move the report by a day.
      const reportDate = dto.date.slice(0, 10);
      const parsedReportDate = new Date(`${reportDate}T00:00:00.000Z`);
      if (!Number.isFinite(parsedReportDate.getTime())) {
        throw new Error(`Invalid Day Book date: ${dto.date}`);
      }
      const nextDate = new Date(parsedReportDate);
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      const startOfDay = `${reportDate} 00:00:00`;
      const startOfNextDay = `${nextDate.toISOString().slice(0, 10)} 00:00:00`;

      // Get transactions from ledger for the selected date
      let query = this.ledgerRepository
        .createQueryBuilder('l')
        .where('l.trans_date >= :startDate AND l.trans_date < :endDate', {
          startDate: startOfDay,
          endDate: startOfNextDay
        });

      // Scope account-specific day books by their ledger identity. CD activity
      // exists in legacy rows under any of these markers, depending on the
      // workflow that created it: account type, GL head, or voucher type.
      if (dto.filterType === 'sb' || dto.filterType === 'savings') {
        // Filter for Savings Bank related transactions (acc_type = 'SB' or code relates to savings)
        query = query.andWhere('(l.acc_type = :sbType OR l.code = :sbCode)', {
          sbType: 'SB',
          sbCode: 'A1001'
        });
      } else if (dto.filterType === 'cd') {
        query = query.andWhere('(l.acc_type = :cdType OR l.code = :cdCode OR l.vchr_type = :cdVoucherType)', {
          cdType: 'CD',
          cdCode: 'L1004',
          cdVoucherType: 'CD'
        });
      }

      const ledgerEntries = await query
        .orderBy('l.trans_date', 'ASC')
        .addOrderBy('l.trans_no', 'ASC')
        .getMany();

      const invalidEntry = ledgerEntries.find(l => !this.normalizeTransactionType(l.trans_type, dto.filterType));
      if (invalidEntry) {
        throw new Error(`Ledger transaction ${invalidEntry.trans_no} has unsupported type '${invalidEntry.trans_type}'.`);
      }
      const invalidAmountEntry = ledgerEntries.find(l => !Number.isFinite(Number(l.trans_amt)));
      if (invalidAmountEntry) {
        throw new Error(`Ledger transaction ${invalidAmountEntry.trans_no} has an invalid amount.`);
      }

      // Get all head names for the codes found in ledger
      const codes = [...new Set(ledgerEntries.map(l => l.code))].filter(Boolean);
      const headNames = new Map<string, string>();

      if (codes.length > 0) {
        // We can query head_master via raw query if repository is not available, 
        // but let's assume we can get it from our list or inject HeadMaster later.
        // For now, I'll use the existing helper but more robustly.
        const heads = await this.ledgerRepository.query(
          `SELECT code, head_name FROM head_master WHERE code IN (${codes.map((_, i) => `$${i + 1}`).join(',')})`,
          codes
        );
        heads.forEach((h: any) => headNames.set(h.code.trim(), h.head_name));
      }

      // Transform ledger entries to day book entries
      const entries: DayBookEntryDto[] = await Promise.all(
        ledgerEntries.map(async (l) => {
          // Get member information
          let memberName = 'Unknown';
          const mbNoStr = l.mbno?.toString();

          if (mbNoStr && mbNoStr !== '0') {
            try {
              const member = await this.memberRepository.findOne({
                where: { mbno: mbNoStr }
              });
              if (member) {
                memberName = `${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim();
              }
            } catch (error) {
              this.logger.warn(`Failed to fetch member ${l.mbno}:`, error.message);
            }
          }

          const reportHeadCode = this.getReportHeadCode(l, dto.filterType);
          const resolvedHeadName = dto.filterType === 'cd' && reportHeadCode === 'L1004'
            ? 'Compulsory Deposit'
            : headNames.get(reportHeadCode) || this.getHeadNameByCode(reportHeadCode);

          return {
            mbNo: mbNoStr || '0',
            memberName,
            voucherNo: l.receipt_vchr_no || '-',
            transactionType: this.normalizeTransactionType(l.trans_type, dto.filterType)!,
            amount: Number(l.trans_amt) || 0,
            headCode: reportHeadCode,
            headName: resolvedHeadName,
            narration: l.narration || '',
            username: l.username || '',
            transactionTime: l.trans_date
          };
        })
      );

      // Calculate opening balance (balance before the selected date)
      const openingBalance = await this.calculateOpeningBalance(startOfDay, dto.filterType);

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
      'L1004': 'Compulsory Deposit',
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

  private async calculateOpeningBalance(date: string, filterType?: string): Promise<number> {
    let query = this.ledgerRepository
      .createQueryBuilder('l')
      .where('l.trans_date < :date', { date });

      // Keep the opening-balance scope identical to the selected report rows.
      if (filterType === 'sb' || filterType === 'savings') {
      query = query.andWhere('(l.acc_type = :sbType OR l.code = :sbCode)', {
        sbType: 'SB',
        sbCode: 'A1001'
      });
    } else if (filterType === 'cd') {
      query = query.andWhere('(l.acc_type = :cdType OR l.code = :cdCode OR l.vchr_type = :cdVoucherType)', {
        cdType: 'CD',
        cdCode: 'L1004',
        cdVoucherType: 'CD'
      });
    }

    const creditTypes = filterType === 'cd' ? "'CR', 'R'" : "'CR'";
    const debitTypes = filterType === 'cd' ? "'DR', 'P'" : "'DR'";
    const supportedTypes = filterType === 'cd' ? "'CR', 'DR', 'R', 'P'" : "'CR', 'DR'";
    const results = await query
      .select(`
          SUM(CASE WHEN l.trans_type IN (${creditTypes}) THEN l.trans_amt ELSE 0 END) -
          SUM(CASE WHEN l.trans_type IN (${debitTypes}) THEN l.trans_amt ELSE 0 END)
        `, 'balance')
      .addSelect(`COUNT(*) FILTER (WHERE l.trans_type NOT IN (${supportedTypes}))`, 'unsupportedCount')
      .getRawOne();

    if (Number(results?.unsupportedCount ?? 0) > 0) {
      throw new Error('Earlier ledger rows contain unsupported transaction types; opening balance cannot be trusted.');
    }

    // SUM is null only when there are no earlier ledger rows. A query error
    // must propagate so the report cannot present a fabricated zero balance.
    return results?.balance == null ? 0 : Number(results.balance);
  }

  private normalizeTransactionType(value: unknown, filterType?: string): 'CR' | 'DR' | null {
    const type = String(value ?? '').trim().toUpperCase();
    if (type === 'CR' || (filterType === 'cd' && type === 'R')) return 'CR';
    if (type === 'DR' || (filterType === 'cd' && type === 'P')) return 'DR';
    return null;
  }

  private getReportHeadCode(entry: Ledger, filterType?: string): string {
    const code = (entry.code || '').trim();
    // Some CD posting paths write the account voucher marker but omit the GL
    // code on the member-side ledger row. The report is already CD-scoped.
    return filterType === 'cd' && !code ? 'L1004' : code;
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
