import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactions } from '../cashbook/entities/transactions.entity';
import { HeadMaster } from './entities/head-master.entity';
import { ReportHeadOrderService } from '../report-head-order/report-head-order.service';
import {
  GetConsolidationDto,
} from './dto/consolidation.dto';

@Injectable()
export class ConsolidationService {
  private readonly logger = new Logger(ConsolidationService.name);

  constructor(
    @InjectRepository(Transactions)
    private transactionsRepository: Repository<Transactions>,
    @InjectRepository(HeadMaster)
    private headMasterRepository: Repository<HeadMaster>,
    private headOrder: ReportHeadOrderService,
  ) { }

  /**
   * Consolidation of the day's accounts, in the shape the window reads:
   * receiptGroups (CR) and paymentGroups (DR) by head, each with a line per member, plus the
   * Cash-In-Hand (A1001) opening, cash movement and closing.
   *
   * - Rows: every ledger leg of the day except Cash-In-Hand, one per ledger id, with the head
   *   name from headmaster and the member name from member_master. Legs without a voucher
   *   number are skipped.
   * - Opening / closing and the two totals are the real Cash-In-Hand position and movement, the
   *   same as the Day-Book. They cannot be the sum of the groups: every voucher balances, so the
   *   groups would always give receipts equal to payments and a closing balance that never moves.
   * - The day is matched on the calendar-date string (ledger.trans_date has no time zone).
   * - Heads keep the order set in Report Head Order.
   */
  async getConsolidationReport(dto: GetConsolidationDto): Promise<any> {
    try {
      const reportDate = String(dto.date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
        throw new Error(`Invalid consolidation date: ${dto.date}`);
      }

      const rows = await this.transactionsRepository.query(`
        SELECT DISTINCT ON (l.ledgerid)
          l.ledgerid,
          l.code                                                  AS head_code,
          COALESCE(h.head_name, l.code)                           AS head_name,
          l.trans_type,
          CAST(l.trans_amt AS numeric)                            AS amount,
          CAST(l.mbno AS text)                                    AS mb_no,
          TRIM(
            COALESCE(m.f_name,'') || ' ' ||
            COALESCE(m.m_name,'') || ' ' ||
            COALESCE(m.l_name,'')
          )                                                       AS member_name
        FROM ledger l
        LEFT JOIN headmaster      h  ON h.code   = l.code
        LEFT JOIN member_master   m  ON CAST(m.mbno AS text) = CAST(l.mbno AS text)
        WHERE l.trans_date::date = $1::date
          AND l.code IS NOT NULL AND TRIM(l.code) != ''
          AND l.code != 'A1001'
          AND l.receipt_vchr_no IS NOT NULL AND TRIM(l.receipt_vchr_no) != ''
        ORDER BY l.ledgerid, l.code, l.trans_type
      `, [reportDate]);

      const openingResult = await this.transactionsRepository.query(`
        SELECT
          SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE 0 END) -
          SUM(CASE WHEN trans_type = 'CR' THEN CAST(trans_amt AS numeric) ELSE 0 END) AS balance
        FROM ledger
        WHERE trans_date::date < $1::date AND code = 'A1001'
      `, [reportDate]);
      const openingBalance = parseFloat(openingResult[0]?.balance) || 0;

      const cashMoveResult = await this.transactionsRepository.query(`
        SELECT
          SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE 0 END) AS cash_in,
          SUM(CASE WHEN trans_type = 'CR' THEN CAST(trans_amt AS numeric) ELSE 0 END) AS cash_out
        FROM ledger
        WHERE trans_date::date = $1::date AND code = 'A1001'
      `, [reportDate]);
      const totalCashReceipts = parseFloat(cashMoveResult[0]?.cash_in) || 0;
      const totalCashPayments = parseFloat(cashMoveResult[0]?.cash_out) || 0;

      // CR legs are receipts, DR legs are payments. Inside each head, one line per member
      // ('Miscellineous' when the leg has no member).
      type Group = { headCode: string; headName: string; total: number; subEntries: Map<string, { mbNo: string; memberName: string; amount: number }> };
      const receiptMap = new Map<string, Group>();
      const paymentMap = new Map<string, Group>();

      for (const row of rows) {
        const amt = parseFloat(row.amount) || 0;
        const map = row.trans_type === 'CR' ? receiptMap : paymentMap;

        let group = map.get(row.head_code);
        if (!group) {
          group = { headCode: row.head_code, headName: row.head_name || row.head_code, total: 0, subEntries: new Map() };
          map.set(row.head_code, group);
        }
        group.total += amt;

        const mbNo = (row.mb_no && row.mb_no !== '0' && row.mb_no !== 'null') ? row.mb_no : null;
        const subKey = mbNo || 'MISC';
        const memberLabel = row.member_name?.trim() || (mbNo ? `Member ${mbNo}` : 'Miscellineous');
        let sub = group.subEntries.get(subKey);
        if (!sub) {
          sub = { mbNo: mbNo || '', memberName: memberLabel, amount: 0 };
          group.subEntries.set(subKey, sub);
        }
        sub.amount += amt;
      }

      const toGroups = async (m: Map<string, Group>) => {
        const list = Array.from(m.values()).map(g => ({
          headCode: g.headCode,
          headName: g.headName,
          total: g.total,
          subEntries: Array.from(g.subEntries.values()),
        }));
        return this.headOrder.sortByHeadOrder(list, (g: any) => g.headCode);
      };

      const receiptGroups = await toGroups(receiptMap);
      const paymentGroups = await toGroups(paymentMap);

      const totalCash = openingBalance + totalCashReceipts;
      const closingBalance = totalCash - totalCashPayments;

      return {
        date: dto.date,
        openingBalance,
        totalReceipts: totalCashReceipts,
        totalPayments: totalCashPayments,
        totalCash,
        closingBalance,
        netBalance: totalCashReceipts - totalCashPayments,
        receiptGroups,
        paymentGroups,
        totalHeads: receiptMap.size + paymentMap.size,
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