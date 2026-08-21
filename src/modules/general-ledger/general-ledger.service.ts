import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ledger } from '../member-ledger/entities/ledger.entity';
import {
  GetGeneralLedgerDto,
  GeneralLedgerSummaryDto,
  GeneralLedgerEntryDto,
  HeadMasterDto
} from './dto/general-ledger.dto';
import { isDebitNormal, calculateClosingBalance } from '../shared/utils/balance-direction';

@Injectable()
export class GeneralLedgerService {
  private readonly logger = new Logger(GeneralLedgerService.name);

  constructor(
    @InjectRepository(Ledger)
    private ledgerRepository: Repository<Ledger>,
  ) {}

  async getGeneralLedgerReport(dto: GetGeneralLedgerDto): Promise<GeneralLedgerSummaryDto> {
    try {
      // BUG FIX: accountbalance is empty in this database (0 rows, confirmed
      // live) — this always fell straight through to dto.headCode, so the
      // report displayed the raw code instead of a real name. Same gap
      // already fixed for the dropdown a few lines below (see the other
      // BUG FIX comment); the query for pflag right below this already reads
      // headmaster for this exact code, so head_name is grabbed in the same
      // trip instead of a third query.
      const headNameResult = await this.ledgerRepository.query(
        `SELECT acname FROM accountbalance WHERE acno = $1 LIMIT 1`,
        [dto.headCode]
      );

      const headmasterResult = await this.ledgerRepository.query(
        `SELECT pflag, head_name FROM headmaster WHERE code = $1 LIMIT 1`,
        [dto.headCode]
      );
      const pflag = headmasterResult[0]?.pflag || '';
      const debitNormal = isDebitNormal(pflag);
      const headName = headNameResult[0]?.acname || headmasterResult[0]?.head_name || dto.headCode;

      // Entries deduped with DISTINCT ON, date filter via ::date cast (no IST issues)
      const rows = await this.ledgerRepository.query(`
        SELECT DISTINCT ON (l.ledgerid)
          l.ledgerid,
          l.trans_date,
          COALESCE(l.receipt_vchr_no, '') AS voucher_no,
          COALESCE(l.narration, '')       AS narration,
          l.trans_type,
          CAST(l.trans_amt AS numeric)    AS amount,
          CAST(l.mbno AS text)            AS mb_no,
          l.acc_no,
          COALESCE(l.username, '')        AS username
        FROM ledger l
        WHERE l.code = $1
          AND l.trans_date::date >= $2::date
          AND l.trans_date::date <= $3::date
        ORDER BY l.ledgerid, l.trans_date
      `, [dto.headCode, dto.fromDate, dto.toDate]);

      // Opening balance: all entries for this head before fromDate, deduped
      // Debit-normal (A/E): opening = SUM(DR) - SUM(CR)
      // Credit-normal (L/I/R): opening = SUM(CR) - SUM(DR)
      const openingResult = await this.ledgerRepository.query(`
        SELECT
          COALESCE(SUM(CASE WHEN trans_type='DR' THEN amt ELSE 0 END), 0) AS total_dr,
          COALESCE(SUM(CASE WHEN trans_type='CR' THEN amt ELSE 0 END), 0) AS total_cr
        FROM (
          SELECT DISTINCT ON (ledgerid)
            ledgerid, trans_type, CAST(trans_amt AS numeric) AS amt
          FROM ledger
          WHERE code = $1
            AND trans_date::date < $2::date
          ORDER BY ledgerid
        ) t
      `, [dto.headCode, dto.fromDate]);

      const opDr = parseFloat(openingResult[0]?.total_dr) || 0;
      const opCr = parseFloat(openingResult[0]?.total_cr) || 0;

      const openingBalance = debitNormal ? (opDr - opCr) : (opCr - opDr);

      let runningBalance = openingBalance;
      const entries: GeneralLedgerEntryDto[] = rows.map((r: any) => {
        const amount = parseFloat(r.amount) || 0;
        const debit  = r.trans_type === 'DR' ? amount : 0;
        const credit = r.trans_type === 'CR' ? amount : 0;
        runningBalance += debitNormal ? (debit - credit) : (credit - debit);
        return {
          transactionNo:   r.ledgerid,
          transactionDate: r.trans_date,
          voucherNo:       r.voucher_no || '',
          narration:       r.narration,
          debit,
          credit,
          balance:         runningBalance,
          transactionType: r.trans_type as 'DR' | 'CR',
          memberNumber:    r.mb_no || undefined,
          accountNumber:   r.acc_no || undefined,
          username:        r.username,
        };
      });

      const totalDebits  = entries.reduce((s, e) => s + e.debit,  0);
      const totalCredits = entries.reduce((s, e) => s + e.credit, 0);
      const closingBalance = calculateClosingBalance(pflag, openingBalance, totalDebits, totalCredits);

      return {
        headCode: dto.headCode,
        headName,
        fromDate: dto.fromDate,
        toDate:   dto.toDate,
        openingBalance,
        totalDebits,
        totalCredits,
        closingBalance,
        entries,
        totalTransactions: entries.length,
      };

    } catch (error) {
      this.logger.error('Error generating general ledger report:', error);
      throw new Error('Failed to generate general ledger report');
    }
  }

  async getHeadMasters(): Promise<HeadMasterDto[]> {
    try {
      // BUG FIX: accountbalance is empty in this database (0 rows) — this
      // dropdown silently had zero options. headmaster is the real,
      // populated source of GL codes; accountbalance is only used when it
      // actually has rows (kept as originally intended for whichever
      // environment populates it with richer names).
      const rows = await this.ledgerRepository.query(`
        SELECT acno AS code, acname AS head_name
        FROM accountbalance
        WHERE acno IS NOT NULL AND TRIM(acno) != ''
        ORDER BY acno
      `);
      if (rows.length > 0) {
        return rows.map((r: any) => ({
          code:     r.code,
          headName: r.head_name || r.code,
        }));
      }

      const headmasterRows = await this.ledgerRepository.query(`
        SELECT code, head_name
        FROM headmaster
        WHERE code IS NOT NULL AND TRIM(code) != ''
        ORDER BY code
      `);
      return headmasterRows.map((r: any) => ({
        code:     r.code,
        headName: r.head_name || r.code,
      }));
    } catch (error) {
      this.logger.error('Error fetching head masters:', error);
      return [];
    }
  }
}
