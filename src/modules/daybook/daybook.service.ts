import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { generateVoucherNo } from '../shared/utils/voucher-utils';
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

  async getDayBookReport(dto: GetDayBookDto): Promise<any> {
    try {
      // Single JOIN query — member names + accountbalance names in one shot, no N+1
      const rows = await this.ledgerRepository.query(`
        SELECT DISTINCT ON (l.ledgerid)
          l.ledgerid,
          l.trans_type,
          CAST(l.mbno AS text)                              AS mb_no,
          l.code                                            AS head_code,
          COALESCE(ab.acname, l.code)                       AS head_name,
          CAST(l.trans_amt AS numeric)                      AS amount,
          COALESCE(l.receipt_vchr_no, '')                   AS voucher_no,
          COALESCE(l.username, '')                          AS username,
          TRIM(
            COALESCE(m.f_name,'') || ' ' ||
            COALESCE(m.m_name,'') || ' ' ||
            COALESCE(m.l_name,'')
          )                                                 AS member_name
        FROM ledger l
        LEFT JOIN accountbalance  ab ON ab.acno  = l.code
        LEFT JOIN member_master   m  ON CAST(m.mbno AS text) = CAST(l.mbno AS text)
        WHERE l.trans_date::date = $1::date
          AND l.code IS NOT NULL AND TRIM(l.code) != ''
          AND l.code != 'A1001'
          AND l.receipt_vchr_no IS NOT NULL AND TRIM(l.receipt_vchr_no) != ''
        ORDER BY l.ledgerid, l.code, l.trans_type
      `, [dto.date]);

      // Opening balance from daily_gl_history + subsequent ledger/tblcashbook deltas
      const openingResult = await this.ledgerRepository.query(`
        WITH last_gl AS (
          SELECT CAST(balance AS numeric) AS bal, trans_date::date AS gl_date
          FROM daily_gl_history
          WHERE code = 'A1001' AND trans_date::date < $1::date
          ORDER BY trans_date DESC LIMIT 1
        )
        SELECT
          COALESCE((SELECT bal FROM last_gl), 0)
          + COALESCE((
            SELECT SUM(CASE WHEN t.trans_type='DR' THEN t.amt ELSE -t.amt END)
            FROM (
              SELECT DISTINCT ON (ledgerid)
                ledgerid, trans_type, CAST(trans_amt AS numeric) AS amt, trans_date
              FROM ledger WHERE code='A1001' AND acc_type='CINH'
              ORDER BY ledgerid
            ) t
            WHERE t.trans_date::date > COALESCE((SELECT gl_date FROM last_gl),'2000-01-01')
              AND t.trans_date::date < $1::date
          ), 0)
          + COALESCE((
            SELECT SUM(COALESCE(rcash,0)+COALESCE(rtransfer,0))
                   - SUM(COALESCE(pcash,0)+COALESCE(ptransfer,0))
            FROM tblcashbook
            WHERE trans_date IS NOT NULL
              AND trans_date::date > COALESCE((SELECT gl_date FROM last_gl),'2000-01-01')
              AND trans_date::date < $1::date
          ), 0) AS opening_balance
      `, [dto.date]);

      const openingBalance = parseFloat(openingResult[0]?.opening_balance) || 0;

      // Group into Payment (DR) and Receipt (CR) by head code
      const paymentMap = new Map<string, { headCode: string; headName: string; entries: any[] }>();
      const receiptMap = new Map<string, { headCode: string; headName: string; entries: any[] }>();

      for (const row of rows) {
        const mbNo = row.mb_no && row.mb_no !== '0' ? row.mb_no : '';
        const entry = {
          mbNo,
          memberName: row.member_name?.trim() || '',
          voucherNo: row.voucher_no,
          amount: parseFloat(row.amount) || 0,
          username: row.username,
        };

        const map = row.trans_type === 'DR' ? paymentMap : receiptMap;
        if (!map.has(row.head_code)) {
          map.set(row.head_code, { headCode: row.head_code, headName: row.head_name || row.head_code, entries: [] });
        }
        map.get(row.head_code)!.entries.push(entry);
      }

      const toGroups = (m: typeof paymentMap) =>
        Array.from(m.values()).map(g => ({
          ...g,
          total: g.entries.reduce((s, e) => s + e.amount, 0),
        }));

      const paymentGroups = toGroups(paymentMap);
      const receiptGroups = toGroups(receiptMap);
      const totalPayments = paymentGroups.reduce((s, g) => s + g.total, 0);
      const totalReceipts = receiptGroups.reduce((s, g) => s + g.total, 0);
      const closingBalance = openingBalance + totalReceipts - totalPayments;

      return {
        date: dto.date,
        openingBalance,
        totalReceipts,
        totalPayments,
        netBalance: totalReceipts - totalPayments,
        closingBalance,
        paymentGroups,
        receiptGroups,
        totalTransactions: rows.length,
      };

    } catch (error) {
      this.logger.error('Error generating day book report:', error);
      throw new Error('Failed to generate day book report');
    }
  }

  async getDayBookSBReport(date: string): Promise<any> {
    try {
      // SB transactions for the date — split by modeofpay (C=Cash, others=Transfer)
      const rows = await this.ledgerRepository.query(`
        SELECT DISTINCT ON (l.ledgerid)
          l.ledgerid                                             AS tr_no,
          COALESCE(CAST(l.acc_no AS text), '')                  AS acc_no,
          TRIM(
            COALESCE(m.f_name,'') || ' ' ||
            COALESCE(m.m_name,'') || ' ' ||
            COALESCE(m.l_name,'')
          )                                                      AS ac_name,
          l.trans_type,
          UPPER(COALESCE(l.modeofpay, 'C'))                     AS modeofpay,
          CAST(l.trans_amt AS numeric)                           AS amount
        FROM ledger l
        LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(l.mbno AS text)
        WHERE l.trans_date::date = $1::date
          AND l.acc_type = 'SB'
        ORDER BY l.ledgerid
      `, [date]);

      // Opening balance: cumulative SB balance before date (dedup ledgerid)
      const openingResult = await this.ledgerRepository.query(`
        SELECT COALESCE(
          SUM(CASE WHEN trans_type='CR' THEN amt ELSE -amt END), 0
        ) AS opening_balance
        FROM (
          SELECT DISTINCT ON (ledgerid)
            ledgerid, trans_type, CAST(trans_amt AS numeric) AS amt
          FROM ledger
          WHERE acc_type = 'SB' AND trans_date::date < $1::date
          ORDER BY ledgerid
        ) t
      `, [date]);

      const openingBalance = parseFloat(openingResult[0]?.opening_balance) || 0;

      const entries = rows.map((r: any, idx: number) => {
        const amt = parseFloat(r.amount) || 0;
        const isCash = r.modeofpay === 'C';
        const isDeposit = r.trans_type === 'CR';
        return {
          srNo: idx + 1,
          accNo: r.acc_no,
          acName: r.ac_name?.trim() || '',
          depositCash: isDeposit && isCash ? amt : 0,
          depositTransfer: isDeposit && !isCash ? amt : 0,
          withdrawalCash: !isDeposit && isCash ? amt : 0,
          withdrawalTransfer: !isDeposit && !isCash ? amt : 0,
        };
      });

      const totalDepositCash = entries.reduce((s: number, e: any) => s + e.depositCash, 0);
      const totalDepositTransfer = entries.reduce((s: number, e: any) => s + e.depositTransfer, 0);
      const totalWithdrawalCash = entries.reduce((s: number, e: any) => s + e.withdrawalCash, 0);
      const totalWithdrawalTransfer = entries.reduce((s: number, e: any) => s + e.withdrawalTransfer, 0);
      const totalDeposit = totalDepositCash + totalDepositTransfer;
      const totalWithdrawal = totalWithdrawalCash + totalWithdrawalTransfer;
      const closingBalance = openingBalance + totalDeposit - totalWithdrawal;

      return {
        date,
        openingBalance,
        totalDepositCash,
        totalDepositTransfer,
        totalDeposit,
        totalWithdrawalCash,
        totalWithdrawalTransfer,
        totalWithdrawal,
        totalCashInHand: openingBalance + totalDeposit,
        closingBalance,
        totalTransactions: entries.length,
        entries,
      };
    } catch (error) {
      this.logger.error('Error generating SB day book report:', error);
      throw new Error('Failed to generate SB day book report');
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

      // A handful of legacy/test rows have a null mbno despite it being the
      // primary key at the entity level (schema predates synchronize:false,
      // so the DB never actually enforced NOT NULL here). Skip them instead
      // of letting one bad row crash the whole list.
      return members
        .filter(member => member.mbno != null)
        .map(member => ({
          memberCode: member.mbno.toString(),
          memberName: `${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim(),
          status: member.isactive
        }));

    } catch (error) {
      this.logger.error(`Error fetching active members: ${error instanceof Error ? error.message : String(error)}`);
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
      // Canonical Receipt voucher number from voucher_master (R counter)
      const voucherNo = await generateVoucherNo(this.ledgerRepository.manager, 'R');

      // Create transaction record for interest payment
      const transaction = this.transactionsRepository.create({
        trans_no: nextTransNo,
        trans_date: paymentDate,
        trans_type: 'CR',
        mbno: memberCode,
        acc_no: 0,
        acc_type: 'SB',
        trans_amt: dto.interestAmount.toString(),
        receipt_vchr_no: voucherNo,
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
        receipt_vchr_no: voucherNo,
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
      let query = this.ledgerRepository
        .createQueryBuilder('l')
        .where('l.trans_date < :date', { date });

      // Add filtering for SB transactions if specified
      if (filterType === 'sb' || filterType === 'savings') {
        query = query.andWhere('(l.acc_type = :sbType OR l.code = :sbCode)', {
          sbType: 'SB',
          sbCode: 'A1001'
        });
      }

      const results = await query
        .select(`
          SUM(CASE WHEN l.trans_type = 'CR' THEN l.trans_amt ELSE 0 END) - 
          SUM(CASE WHEN l.trans_type = 'DR' THEN l.trans_amt ELSE 0 END)
        `, 'balance')
        .getRawOne();

      return Number(results?.balance || 0);
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