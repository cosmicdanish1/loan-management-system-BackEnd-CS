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
  ) { }

  async getConsolidationReport(dto: GetConsolidationDto): Promise<ConsolidationSummaryDto> {
    try {
      const reportDate = new Date(dto.date);
      const startOfDay = new Date(reportDate);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(reportDate);
      endOfDay.setHours(23, 59, 59, 999);

      // Get summary from ledger for the selected date
      const ledgerSummary = await this.transactionsRepository.query(`
        SELECT 
          l.code as "headCode",
          MAX(h.head_name) as "headName",
          SUM(CASE WHEN l.trans_type = 'CR' THEN l.trans_amt ELSE 0 END) as receipts,
          SUM(CASE WHEN l.trans_type = 'DR' THEN l.trans_amt ELSE 0 END) as payments
        FROM ledger l
        LEFT JOIN head_master h ON l.code = h.code
        WHERE l.trans_date >= $1 AND l.trans_date <= $2
        GROUP BY l.code
        ORDER BY l.code ASC
      `, [startOfDay, endOfDay]);

      const entries: ConsolidationEntryDto[] = ledgerSummary.map((item: any) => ({
        headCode: (item.headCode || '').trim(),
        headName: item.headName || `Head ${item.headCode}`,
        receipts: Number(item.receipts) || 0,
        payments: Number(item.payments) || 0,
        netAmount: (Number(item.receipts) || 0) - (Number(item.payments) || 0)
      }));

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