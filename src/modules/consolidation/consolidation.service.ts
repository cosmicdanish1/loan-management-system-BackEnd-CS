import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactions } from '../cashbook/entities/transactions.entity';
import { HeadMaster } from './entities/head-master.entity';
import {
  GetConsolidationDto,
  ConsolidationSummaryDto,
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

  async getConsolidationReport(dto: GetConsolidationDto): Promise<any> {
    try {
      // All voucher entries for the date — deduped, with accountbalance names + member names
      const rows = await this.transactionsRepository.query(`
        SELECT DISTINCT ON (l.ledgerid)
          l.ledgerid,
          l.code                                                  AS head_code,
          COALESCE(ab.acname, l.code)                             AS head_name,
          l.trans_type,
          CAST(l.trans_amt AS numeric)                            AS amount,
          CAST(l.mbno AS text)                                    AS mb_no,
          TRIM(
            COALESCE(m.f_name,'') || ' ' ||
            COALESCE(m.m_name,'') || ' ' ||
            COALESCE(m.l_name,'')
          )                                                       AS member_name
        FROM ledger l
        LEFT JOIN accountbalance  ab ON ab.acno  = l.code
        LEFT JOIN member_master   m  ON CAST(m.mbno AS text) = CAST(l.mbno AS text)
        WHERE l.trans_date::date = $1::date
          AND l.code IS NOT NULL AND TRIM(l.code) != ''
          AND l.receipt_vchr_no IS NOT NULL AND TRIM(l.receipt_vchr_no) != ''
        ORDER BY l.ledgerid, l.code, l.trans_type
      `, [dto.date]);

      // Opening balance (A1001 cash in hand) from daily_gl_history + ledger delta
      const openingResult = await this.transactionsRepository.query(`
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

      // Group rows into receiptGroups (CR) and paymentGroups (DR) by head_code
      // Within each head, sub-group by mb_no (member) or 'Miscellineous' for no member
      const receiptMap = new Map<string, any>();
      const paymentMap = new Map<string, any>();

      for (const row of rows) {
        const amt = parseFloat(row.amount) || 0;
        const map = row.trans_type === 'CR' ? receiptMap : paymentMap;

        if (!map.has(row.head_code)) {
          map.set(row.head_code, {
            headCode: row.head_code,
            headName: row.head_name || row.head_code,
            total: 0,
            subEntries: new Map<string, any>(),
          });
        }

        const group = map.get(row.head_code)!;
        group.total += amt;

        const mbNo = (row.mb_no && row.mb_no !== '0' && row.mb_no !== 'null')
          ? row.mb_no
          : null;
        const subKey = mbNo || 'MISC';
        const memberLabel = row.member_name?.trim() || (mbNo ? `Member ${mbNo}` : 'Miscellineous');

        if (!group.subEntries.has(subKey)) {
          group.subEntries.set(subKey, { mbNo: mbNo || '', memberName: memberLabel, amount: 0 });
        }
        group.subEntries.get(subKey)!.amount += amt;
      }

      const toGroups = (m: Map<string, any>) =>
        Array.from(m.values()).map(g => ({
          headCode: g.headCode,
          headName: g.headName,
          total: g.total,
          subEntries: Array.from(g.subEntries.values()),
        })).sort((a, b) => a.headCode.localeCompare(b.headCode));

      const receiptGroups = toGroups(receiptMap);
      const paymentGroups = toGroups(paymentMap);

      const totalReceipts = receiptGroups.reduce((s, g) => s + g.total, 0);
      const totalPayments = paymentGroups.reduce((s, g) => s + g.total, 0);
      const totalCash = openingBalance + totalReceipts;
      const closingBalance = totalCash - totalPayments;

      return {
        date: dto.date,
        openingBalance,
        totalReceipts,
        totalPayments,
        totalCash,
        closingBalance,
        receiptGroups,
        paymentGroups,
        totalHeads: receiptMap.size + paymentMap.size,
      };

    } catch (error) {
      this.logger.error('Error generating consolidation report:', error);
      throw new Error('Failed to generate consolidation report');
    }
  }
}
