import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactions } from '../cashbook/entities/transactions.entity';
import { HeadMaster } from './entities/head-master.entity';
import { 
  GetConsolidationDto, 
  ConsolidationSummaryDto, 
  ConsolidationEntryDto 
} from './dto/consolidation.dto';

@Injectable()
export class ConsolidationService {
  private readonly logger = new Logger(ConsolidationService.name);

  constructor(
    @InjectRepository(Transactions)
    private transactionsRepository: Repository<Transactions>,
    @InjectRepository(HeadMaster)
    private headMasterRepository: Repository<HeadMaster>
  ) {}

  async getConsolidationReport(dto: GetConsolidationDto): Promise<ConsolidationSummaryDto> {
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
        .getMany();

      // Group transactions by head code and calculate totals
      const consolidationMap = new Map<string, {
        headCode: string;
        headName: string;
        receipts: number;
        payments: number;
      }>();

      // Process each transaction
      for (const transaction of transactions) {
        const headCode = transaction.code || 'UNKNOWN';
        
        if (!consolidationMap.has(headCode)) {
          // Get head name from headmaster table
          let headName = 'Unknown Head';
          try {
            const headMaster = await this.headMasterRepository.findOne({
              where: { code: headCode }
            });
            if (headMaster) {
              headName = headMaster.head_name || headCode;
            }
          } catch (error) {
            this.logger.warn(`Failed to fetch head name for code ${headCode}:`, error.message);
          }

          consolidationMap.set(headCode, {
            headCode,
            headName,
            receipts: 0,
            payments: 0
          });
        }

        const entry = consolidationMap.get(headCode)!;
        const amount = this.parseMoneyAmount(transaction.trans_amt);

        if (transaction.trans_type === 'CR') {
          entry.receipts += amount;
        } else if (transaction.trans_type === 'DR') {
          entry.payments += amount;
        }
      }

      // Convert map to array and calculate net amounts
      const entries: ConsolidationEntryDto[] = Array.from(consolidationMap.values())
        .map(entry => ({
          headCode: entry.headCode,
          headName: entry.headName,
          receipts: entry.receipts,
          payments: entry.payments,
          netAmount: entry.receipts - entry.payments
        }))
        .sort((a, b) => a.headCode.localeCompare(b.headCode));

      // Calculate overall totals
      const totalReceipts = entries.reduce((sum, entry) => sum + entry.receipts, 0);
      const totalPayments = entries.reduce((sum, entry) => sum + entry.payments, 0);
      const netBalance = totalReceipts - totalPayments;

      return {
        date: dto.date,
        totalReceipts,
        totalPayments,
        netBalance,
        entries,
        totalHeads: entries.length
      };

    } catch (error) {
      this.logger.error('Error generating consolidation report:', error);
      throw new Error('Failed to generate consolidation report');
    }
  }

  private parseMoneyAmount(moneyValue: string): number {
    // PostgreSQL money type returns values like "$1,234.56" or "₹1,234.56" or "? 1,234.56"
    // Remove currency symbols, question marks, and commas, then parse as float
    if (!moneyValue) return 0;
    const cleanValue = moneyValue.toString().replace(/[$₹,?]/g, '').trim();
    return parseFloat(cleanValue) || 0;
  }
}