import { BadRequestException, HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ledger } from '../member-ledger/entities/ledger.entity';
import { HeadMaster } from '../consolidation/entities/head-master.entity';
import { ALL_LOAN_INTEREST_HEADS, LOAN_INTEREST_PARENT_HEAD } from '../loan/loan-interest-heads';
import { 
  GetGeneralLedgerDto, 
  GeneralLedgerSummaryDto, 
  GeneralLedgerEntryDto,
  HeadMasterDto
} from './dto/general-ledger.dto';

@Injectable()
export class GeneralLedgerService {
  private readonly logger = new Logger(GeneralLedgerService.name);

  constructor(
    @InjectRepository(Ledger)
    private ledgerRepository: Repository<Ledger>,
    @InjectRepository(HeadMaster)
    private headMasterRepository: Repository<HeadMaster>
  ) {}

  async getGeneralLedgerReport(dto: GetGeneralLedgerDto): Promise<GeneralLedgerSummaryDto> {
    try {
      const fromDate = dto.fromDate.slice(0, 10);
      const toDate = dto.toDate.slice(0, 10);
      if (fromDate > toDate) {
        throw new BadRequestException('From date must be on or before the To date');
      }

      // Validate head code exists
      const headMaster = await this.headMasterRepository.findOne({
        where: { code: dto.headCode }
      });

      if (!headMaster) {
        throw new NotFoundException(`Head code ${dto.headCode} not found`);
      }

      const headName = headMaster.head_name || dto.headCode;

      // Get ledger entries for the head code and date range
      // Note: For General Ledger, we get ALL transactions for this head code (all members)
      // ES-47: read RAW rows. The Ledger entity's primary key (trans_no) is not unique in this
      // table, so getMany() silently merged rows sharing a trans_no and dropped ~10% of rows.
      const ledgerEntries = (await this.ledgerRepository
        .createQueryBuilder('l')
        .select([
          'l.trans_no AS trans_no', 'l.trans_date AS trans_date', 'l.trans_type AS trans_type',
          'l.trans_amt AS trans_amt', 'l.receipt_vchr_no AS receipt_vchr_no', 'l.narration AS narration',
          'l.mbno AS mbno', 'l.acc_no AS acc_no', 'l.username AS username',
        ])
        .where('l.code IN (:...headCodes)', { headCodes: this.headCodesFor(dto.headCode) })
        .andWhere("l.trans_date >= CAST(:fromDate AS date) AND l.trans_date < CAST(:toDate AS date) + INTERVAL '1 day'", {
          fromDate,
          toDate,
        })
        .orderBy('l.trans_date', 'ASC')
        .addOrderBy('l.trans_no', 'ASC')
        .addOrderBy('l.ledgerid', 'ASC')
        .getRawMany()) as Array<{
          trans_no: any; trans_date: Date; trans_type: string; trans_amt: any; receipt_vchr_no: string;
          narration: string; mbno: any; acc_no: any; username: string;
        }>;

      // Calculate opening balance (transactions before the from date)
      const openingBalance = await this.calculateOpeningBalance(
        dto.headCode,
        dto.fromDate
      );

      // Transform ledger entries
      let runningBalance = openingBalance;
      const entries: GeneralLedgerEntryDto[] = ledgerEntries.map(entry => {
        const amount = this.parseMoneyAmount(entry.trans_amt.toString());
        const direction = this.normalizeLedgerDirection(entry.trans_type);
        
        // Update running balance
        if (direction === 'CR') {
          runningBalance += amount;
        } else {
          runningBalance -= amount;
        }

        return {
          transactionNo: entry.trans_no,
          transactionDate: entry.trans_date.toISOString(),
          voucherNo: entry.receipt_vchr_no || '',
          narration: entry.narration || '',
          debit: direction === 'DR' ? amount : 0,
          credit: direction === 'CR' ? amount : 0,
          balance: runningBalance,
          transactionType: direction,
          memberNumber: entry.mbno || undefined,
          accountNumber: entry.acc_no || undefined,
          username: entry.username || ''
        };
      });

      // Calculate totals
      const totalDebits = entries.reduce((sum, entry) => sum + entry.debit, 0);
      const totalCredits = entries.reduce((sum, entry) => sum + entry.credit, 0);
      const closingBalance = openingBalance + totalCredits - totalDebits;

      return {
        headCode: dto.headCode,
        headName,
        fromDate: dto.fromDate,
        toDate: dto.toDate,
        openingBalance,
        totalDebits,
        totalCredits,
        closingBalance,
        entries,
        totalTransactions: entries.length
      };

    } catch (error) {
      this.logger.error('Error generating general ledger report:', error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new Error('Failed to generate general ledger report');
    }
  }

  async getHeadMasters(): Promise<HeadMasterDto[]> {
    try {
      const heads = await this.headMasterRepository
        .createQueryBuilder('h')
        .select(['h.code', 'h.head_name', 'h.headtype', 'h.parent_code'])
        .orderBy('h.code', 'ASC')
        .getMany();

      return heads.map(head => ({
        code: head.code,
        headName: head.head_name || head.code,
        headType: head.headtype,
        parentCode: head.parent_code
      }));

    } catch (error) {
      this.logger.error('Error fetching head masters:', error);
      return [];
    }
  }

  /** ES-46: the I1002 loan-interest parent reports as the combined total of itself plus its per-loan-type children. */
  private headCodesFor(headCode: string): string[] {
    return headCode === LOAN_INTEREST_PARENT_HEAD ? ALL_LOAN_INTEREST_HEADS : [headCode];
  }

  private async calculateOpeningBalance(
    headCode: string,
    beforeDate: string
  ): Promise<number> {
    try {
      const result = await this.ledgerRepository
        .createQueryBuilder('l')
        .select(`COALESCE(SUM(CASE
          WHEN UPPER(TRIM(l.trans_type)) IN ('CR', 'R') THEN l.trans_amt
          WHEN UPPER(TRIM(l.trans_type)) IN ('DR', 'P') THEN -l.trans_amt
          ELSE 0
        END), 0)`, 'balance')
        .addSelect(`COUNT(*) FILTER (WHERE UPPER(TRIM(l.trans_type)) NOT IN ('CR', 'R', 'DR', 'P'))`, 'unsupportedCount')
        .where('l.code IN (:...headCodes)', { headCodes: this.headCodesFor(headCode) })
        .andWhere('l.trans_date < CAST(:beforeDate AS date)', { beforeDate })
        .getRawOne() as { balance: string | number; unsupportedCount: string | number };

      if (Number(result?.unsupportedCount) > 0) {
        throw new InternalServerErrorException('The opening balance contains unrecognized transaction types. No report was generated.');
      }
      return Number(result?.balance) || 0;

    } catch (error) {
      this.logger.error('Error calculating opening balance:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('Could not calculate the opening balance. No report was generated.');
    }
  }

  private normalizeLedgerDirection(value: string): 'CR' | 'DR' {
    const type = String(value || '').trim().toUpperCase();
    if (type === 'CR' || type === 'R') return 'CR';
    if (type === 'DR' || type === 'P') return 'DR';
    throw new InternalServerErrorException('The ledger contains an unrecognized transaction type. No balances were produced.');
  }

  private parseMoneyAmount(moneyValue: string): number {
    if (!moneyValue) return 0;
    const cleanValue = moneyValue.toString().replace(/[$₹,?]/g, '').trim();
    return parseFloat(cleanValue) || 0;
  }
}
