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
      // All voucher entries for the date — deduped, with accountbalance/headmaster
      // names + member names. code='A1001' (Cash-In-Hand) is excluded: it's the
      // balance this report tracks (see openingBalance/closingBalance below), not
      // an analysis head to list — same convention as the sibling Day-Book report.
      const rows = await this.transactionsRepository.query(`
        SELECT DISTINCT ON (l.ledgerid)
          l.ledgerid,
          l.code                                                  AS head_code,
          COALESCE(ab.acname, h.head_name, l.code)                AS head_name,
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
        LEFT JOIN headmaster      h  ON h.code   = l.code
        LEFT JOIN member_master   m  ON CAST(m.mbno AS text) = CAST(l.mbno AS text)
        WHERE l.trans_date::date = $1::date
          AND l.code IS NOT NULL AND TRIM(l.code) != ''
          AND l.code != 'A1001'
          AND l.receipt_vchr_no IS NOT NULL AND TRIM(l.receipt_vchr_no) != ''
        ORDER BY l.ledgerid, l.code, l.trans_type
      `, [dto.date]);

      // Opening balance: the real Cash-In-Hand (A1001) position, built from
      // ledger history directly. This used to read a "last known balance" from
      // daily_gl_history — zero rows, nothing has ever written to it — then
      // bridge forward using tblcashbook, a table already proven unreliable
      // elsewhere in this app (most rows carry no trans_date, and rows that do
      // can double-count transactions already in `ledger`). Confirmed live:
      // this produced ₹1,03,331.33 for a date whose real cash position
      // (cross-checked against Cash Book/Day-Book, both already fixed this
      // session) is -₹4,96,595.09. Same root cause and same fix as Day-Book.
      //
      // Filtering by code alone (not acc_type='CINH') matters: cash-mode loan
      // disbursements post code='A1001' with acc_type='ALN', not 'CINH'.
      const openingResult = await this.transactionsRepository.query(`
        SELECT
          SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE 0 END) -
          SUM(CASE WHEN trans_type = 'CR' THEN CAST(trans_amt AS numeric) ELSE 0 END) AS balance
        FROM ledger
        WHERE trans_date::date < $1::date AND code = 'A1001'
      `, [dto.date]);

      const openingBalance = parseFloat(openingResult[0]?.balance) || 0;

      // Same-day movement on the A1001 head itself. This used to be netted
      // from the receipt/payment group totals below — but those groups (with
      // the fix above) list every OTHER head, and even before that fix summed
      // literally every head including A1001, which by basic double-entry
      // bookkeeping guarantees Total Receipts == Total Payments for ANY date
      // (total debits always equal total credits system-wide) — Closing
      // Balance could never move regardless of real activity. Confirmed live:
      // 2026-09-02 showed both totals at the identical ₹5,10,000.00. Cash
      // movement needs its own query, same fix as Day-Book.
      const cashMoveResult = await this.transactionsRepository.query(`
        SELECT
          SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE 0 END) AS cash_in,
          SUM(CASE WHEN trans_type = 'CR' THEN CAST(trans_amt AS numeric) ELSE 0 END) AS cash_out
        FROM ledger
        WHERE trans_date::date = $1::date AND code = 'A1001'
      `, [dto.date]);
      const totalCashReceipts = parseFloat(cashMoveResult[0]?.cash_in) || 0;
      const totalCashPayments = parseFloat(cashMoveResult[0]?.cash_out) || 0;

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

      const totalCash = openingBalance + totalCashReceipts;
      const closingBalance = totalCash - totalCashPayments;

      return {
        date: dto.date,
        openingBalance,
        totalReceipts: totalCashReceipts,
        totalPayments: totalCashPayments,
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
