import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ledger } from './entities/ledger.entity';
import { Transactions } from './entities/transactions.entity';
import { MemberMaster } from '../member/entities/member-master.entity';
import { InterestMaster } from '../interest/entities/interest-master.entity';
import { HeadMaster } from '../print-voucher/entities/head-master.entity';
import {
  GetCashBookDto,
  CashBookSummaryDto,
  CashBookEntryDto,
  CreateTransactionDto
} from './dto/cashbook.dto';

@Injectable()
export class CashBookService {
  private readonly logger = new Logger(CashBookService.name);

  constructor(
    @InjectRepository(Ledger)
    private ledgerRepository: Repository<Ledger>,
    @InjectRepository(Transactions)
    private transactionsRepository: Repository<Transactions>,
    @InjectRepository(MemberMaster)
    private memberRepository: Repository<MemberMaster>,
    @InjectRepository(InterestMaster)
    private interestMasterRepository: Repository<InterestMaster>,
    @InjectRepository(HeadMaster)
    private headMasterRepository: Repository<HeadMaster>
  ) { }

  async getCashBookReport(dto: GetCashBookDto): Promise<CashBookSummaryDto> {
    try {
      const reportDate = new Date(dto.date);
      const startOfDay = new Date(reportDate);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(reportDate);
      endOfDay.setHours(23, 59, 59, 999);

      // Get all transactions for the selected date
      const transactions = await this.transactionsRepository
        .createQueryBuilder('t')
        .where('t.trans_date >= :startDate AND t.trans_date <= :endDate', {
          startDate: startOfDay,
          endDate: endOfDay
        })
        .orderBy('t.code', 'ASC')
        .getMany();

      // Get all head names for the codes found in transactions
      const codes = [...new Set(transactions.map(t => t.code))].filter(Boolean);
      console.log('Fetching head names for codes:', codes);

      const heads = codes.length > 0
        ? await this.headMasterRepository.find({
          where: { code: require('typeorm').In(codes) }
        })
        : [];

      console.log('Fetched heads from DB:', heads.map(h => `${h.code}:${h.head_name}`));
      const headMap = new Map(heads.map(h => [h.code.trim(), h.head_name]));

      // Group transactions by code (head code)
      const groupedTransactions = this.groupTransactionsByCode(transactions, headMap);

      // Calculate opening balance (transactions before the selected date)
      const openingBalance = await this.calculateOpeningBalance(reportDate);

      // Calculate totals - receipts are CR type, payments are DR type
      const totalReceipts = transactions
        .filter(t => t.trans_type === 'CR')
        .reduce((sum, t) => sum + this.parseMoneyAmount(t.trans_amt), 0);

      const totalPayments = transactions
        .filter(t => t.trans_type === 'DR')
        .reduce((sum, t) => sum + this.parseMoneyAmount(t.trans_amt), 0);

      const netBalance = totalReceipts - totalPayments;
      const closingBalance = openingBalance + netBalance;

      return {
        date: dto.date,
        totalReceipts,
        totalPayments,
        netBalance,
        openingBalance,
        closingBalance,
        entries: groupedTransactions
      };

    } catch (error) {
      this.logger.error('Error generating cash book report:', error);
      throw new Error('Failed to generate cash book report');
    }
  }

  private groupTransactionsByCode(transactions: Transactions[], headMap: Map<string, string>): CashBookEntryDto[] {
    const grouped = new Map<string, CashBookEntryDto>();

    transactions.forEach(transaction => {
      const code = transaction.code ? transaction.code.trim() : '';

      if (!grouped.has(code)) {
        grouped.set(code, {
          code: code,
          headName: headMap.get(code) || `Head ${code}`,
          receipt: 0,
          payment: 0
        });
      }

      const entry = grouped.get(code)!;
      if (transaction.trans_type === 'CR') {
        entry.receipt += this.parseMoneyAmount(transaction.trans_amt);
      } else if (transaction.trans_type === 'DR') {
        entry.payment += this.parseMoneyAmount(transaction.trans_amt);
      }
    });

    return Array.from(grouped.values()).sort((a, b) => a.code.localeCompare(b.code));
  }

  private parseMoneyAmount(moneyValue: string): number {
    // PostgreSQL money type returns values like "$1,234.56" or "₹1,234.56" or "? 1,234.56"
    // Remove currency symbols, question marks, and commas, then parse as float
    if (!moneyValue) return 0;
    const cleanValue = moneyValue.toString().replace(/[$₹,?]/g, '').trim();
    return parseFloat(cleanValue) || 0;
  }

  private async calculateOpeningBalance(date: Date): Promise<number> {
    try {
      const transactions = await this.transactionsRepository
        .createQueryBuilder('t')
        .where('t.trans_date < :date', { date })
        .getMany();

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

  async createTransaction(dto: CreateTransactionDto): Promise<Transactions> {
    try {
      // Get next transaction number
      const nextTransNo = await this.getNextTransactionNumber();

      const amount = dto.transType === 'CR' ? dto.credit : dto.debit;
      const transaction = this.transactionsRepository.create({
        trans_no: nextTransNo,
        trans_date: new Date(dto.transDate),
        trans_type: dto.transType,
        mbno: dto.memberCode ? Number(dto.memberCode) : 0,
        acc_no: 0, // Default account number
        acc_type: 'SB', // Savings Bank default
        trans_amt: amount.toString(),
        receipt_vchr_no: dto.voucherNo || '',
        vchr_type: dto.transType === 'CR' ? 'R' : 'P', // Receipt or Payment
        modeofpay: 'C', // Cash default
        cheq_no: '',
        cheq_amt: '0.00',
        cheq_date: null,
        bankname: '',
        pass_flag: 'N',
        cashier_flag: 'N',
        code: dto.headCode,
        narration: dto.narration || '',
        username: dto.createdBy || 'system',
        cust_bank_name: null
      });

      const savedTransaction = await this.transactionsRepository.save(transaction);

      // Also create ledger entry
      await this.createLedgerEntry(dto, nextTransNo);

      return savedTransaction;
    } catch (error) {
      this.logger.error('Error creating transaction:', error);
      throw new Error('Failed to create transaction');
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

  private async createLedgerEntry(dto: CreateTransactionDto, transNo: number): Promise<void> {
    try {
      const ledgerEntry = this.ledgerRepository.create({
        trans_no: transNo,
        trans_date: new Date(dto.transDate),
        trans_type: dto.transType,
        code: dto.headCode,
        mbno: dto.memberCode ? Number(dto.memberCode) : 0,
        acc_no: 0, // Default account number
        acc_type: 'SB', // Savings Bank default
        trans_amt: dto.transType === 'CR' ? dto.credit : dto.debit,
        receipt_vchr_no: dto.voucherNo || '',
        vchr_type: dto.transType === 'CR' ? 'R' : 'P',
        modeofpay: 'C',
        pl_balance: 0, // Will be calculated
        narration: dto.narration || '',
        username: dto.createdBy || 'system',
        cust_bank_name: null
      });

      await this.ledgerRepository.save(ledgerEntry);
    } catch (error) {
      this.logger.error('Error creating ledger entry:', error);
      throw new Error('Failed to create ledger entry');
    }
  }

  async getActiveMembers(): Promise<MemberMaster[]> {
    try {
      return await this.memberRepository.find({
        where: { isactive: 'Y' },
        select: ['mbno', 'f_name', 'm_name', 'l_name', 'isactive'],
        order: { mbno: 'ASC' }
      });
    } catch (error) {
      this.logger.error('Error fetching active members:', error);
      throw new Error('Failed to fetch active members');
    }
  }

  async getCurrentInterestRate(): Promise<number> {
    try {
      const interestMaster = await this.interestMasterRepository
        .createQueryBuilder('im')
        .where('im.effective_date <= :currentDate', { currentDate: new Date() })
        .orderBy('im.effective_date', 'DESC')
        .getOne();

      return interestMaster?.rate || 4.0; // Default 4% if not found
    } catch (error) {
      this.logger.error('Error fetching current interest rate:', error);
      return 4.0; // Default fallback
    }
  }

  async getMemberBalance(memberCode: string): Promise<number> {
    try {
      const result = await this.ledgerRepository
        .createQueryBuilder('l')
        .select(`
          SUM(CASE WHEN l.trans_type = 'CR' THEN l.trans_amt ELSE 0 END) - 
          SUM(CASE WHEN l.trans_type = 'DR' THEN l.trans_amt ELSE 0 END)
        `, 'balance')
        .where('l.mbno = :memberCode', { memberCode: Number(memberCode) })
        .getRawOne();

      return Number(result?.balance || 0);
    } catch (error) {
      this.logger.error('Error calculating member balance:', error);
      return 0;
    }
  }

  async getTransactionsByDateRange(startDate: string, endDate: string): Promise<Transactions[]> {
    try {
      return await this.transactionsRepository
        .createQueryBuilder('t')
        .where('t.trans_date >= :startDate AND t.trans_date <= :endDate', {
          startDate: new Date(startDate),
          endDate: new Date(endDate)
        })
        .orderBy('t.trans_date', 'DESC')
        .addOrderBy('t.trans_no', 'DESC')
        .getMany();
    } catch (error) {
      this.logger.error('Error fetching transactions by date range:', error);
      throw new Error('Failed to fetch transactions');
    }
  }
}