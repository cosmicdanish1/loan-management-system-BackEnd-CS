import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ledger } from '../member-ledger/entities/ledger.entity';
import { HeadMaster } from '../consolidation/entities/head-master.entity';
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
      const fromDate = new Date(dto.fromDate);
      const toDate = new Date(dto.toDate);
      
      // Set time boundaries
      const startOfDay = new Date(fromDate);
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date(toDate);
      endOfDay.setHours(23, 59, 59, 999);

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
      const ledgerEntries = await this.ledgerRepository
        .createQueryBuilder('l')
        .where('l.code = :headCode', { headCode: dto.headCode })
        .andWhere('l.trans_date >= :startDate AND l.trans_date <= :endDate', {
          startDate: startOfDay,
          endDate: endOfDay
        })
        .orderBy('l.trans_date', 'ASC')
        .addOrderBy('l.trans_no', 'ASC')
        .getMany();

      // Calculate opening balance (transactions before the from date)
      const openingBalance = await this.calculateOpeningBalance(
        dto.headCode, 
        startOfDay
      );

      // Transform ledger entries
      let runningBalance = openingBalance;
      const entries: GeneralLedgerEntryDto[] = ledgerEntries.map(entry => {
        const amount = this.parseMoneyAmount(entry.trans_amt.toString());
        
        // Update running balance
        if (entry.trans_type === 'CR') {
          runningBalance += amount;
        } else {
          runningBalance -= amount;
        }

        return {
          transactionNo: entry.trans_no,
          transactionDate: entry.trans_date.toISOString(),
          voucherNo: entry.receipt_vchr_no || '',
          narration: entry.narration || '',
          debit: entry.trans_type === 'DR' ? amount : 0,
          credit: entry.trans_type === 'CR' ? amount : 0,
          balance: runningBalance,
          transactionType: entry.trans_type as 'DR' | 'CR',
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
      if (error instanceof NotFoundException) {
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

  private async calculateOpeningBalance(
    headCode: string, 
    beforeDate: Date
  ): Promise<number> {
    try {
      const entries = await this.ledgerRepository
        .createQueryBuilder('l')
        .where('l.code = :headCode', { headCode })
        .andWhere('l.trans_date < :beforeDate', { beforeDate })
        .getMany();

      let balance = 0;
      for (const entry of entries) {
        const amount = this.parseMoneyAmount(entry.trans_amt.toString());
        if (entry.trans_type === 'CR') {
          balance += amount;
        } else {
          balance -= amount;
        }
      }

      return balance;

    } catch (error) {
      this.logger.error('Error calculating opening balance:', error);
      return 0;
    }
  }

  private parseMoneyAmount(moneyValue: string): number {
    if (!moneyValue) return 0;
    const cleanValue = moneyValue.toString().replace(/[$₹,?]/g, '').trim();
    return parseFloat(cleanValue) || 0;
  }
}