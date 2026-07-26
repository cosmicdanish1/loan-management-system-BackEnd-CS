import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ledger } from './entities/ledger.entity';
import { MemberMaster } from '../member/entities/member-master.entity';
import { HeadMaster } from '../consolidation/entities/head-master.entity';
import {
  GetMemberLedgerDto,
  MemberLedgerSummaryDto,
  MemberLedgerEntryDto,
  HeadMasterDto,
  ValidateMemberDto,
  GetMemberDetailLedgerDto,
  MemberDetailLedgerSummaryDto,
  MemberColumnarLedgerDto
} from './dto/member-ledger.dto';

@Injectable()
export class MemberLedgerService {
  private readonly logger = new Logger(MemberLedgerService.name);

  constructor(
    @InjectRepository(Ledger)
    private ledgerRepository: Repository<Ledger>,
    @InjectRepository(MemberMaster)
    private memberRepository: Repository<MemberMaster>,
    @InjectRepository(HeadMaster)
    private headMasterRepository: Repository<HeadMaster>
  ) { }

  async getMemberLedgerReport(dto: GetMemberLedgerDto): Promise<MemberLedgerSummaryDto> {
    try {
      const memberNumberStr = dto.memberNumber.toString();

      const member = await this.memberRepository.findOne({ where: { mbno: memberNumberStr } });
      if (!member) throw new NotFoundException(`Member ${dto.memberNumber} not found`);

      // Head name from accountbalance (preferred) then head_master
      const headNameResult = await this.ledgerRepository.query(
        `SELECT acname FROM accountbalance WHERE acno = $1 LIMIT 1`, [dto.headCode]
      );
      const headName = headNameResult[0]?.acname || dto.headCode;

      // Entries for the date range — DISTINCT ON to avoid duplicates
      const rows = await this.ledgerRepository.query(`
        SELECT DISTINCT ON (ledgerid)
          ledgerid, trans_date, receipt_vchr_no AS voucher_no,
          COALESCE(narration, '') AS narration,
          trans_type,
          CAST(trans_amt AS numeric) AS amount
        FROM ledger
        WHERE CAST(mbno AS text) = $1
          AND code = $2
          AND trans_date::date >= $3::date
          AND trans_date::date <= $4::date
        ORDER BY ledgerid, trans_date
      `, [memberNumberStr, dto.headCode, dto.fromDate, dto.toDate]);

      // Opening balance: all entries before fromDate for this member + head
      const openingResult = await this.ledgerRepository.query(`
        SELECT COALESCE(
          SUM(CASE WHEN trans_type='CR' THEN amt ELSE -amt END), 0
        ) AS opening_balance
        FROM (
          SELECT DISTINCT ON (ledgerid)
            ledgerid, trans_type, CAST(trans_amt AS numeric) AS amt
          FROM ledger
          WHERE CAST(mbno AS text) = $1
            AND code = $2
            AND trans_date::date < $3::date
          ORDER BY ledgerid
        ) t
      `, [memberNumberStr, dto.headCode, dto.fromDate]);

      const openingBalance = parseFloat(openingResult[0]?.opening_balance) || 0;

      let runningBalance = openingBalance;
      const entries: MemberLedgerEntryDto[] = rows.map((r: any) => {
        const amt = parseFloat(r.amount) || 0;
        const debit = r.trans_type === 'DR' ? amt : 0;
        const credit = r.trans_type === 'CR' ? amt : 0;
        runningBalance += (credit - debit);
        return {
          transactionNo: r.ledgerid,
          transactionDate: r.trans_date,
          voucherNo: r.voucher_no || '',
          narration: r.narration,
          debit,
          credit,
          balance: runningBalance,
          transactionType: r.trans_type as 'DR' | 'CR',
          username: '',
        };
      });

      const totalDebits = entries.reduce((s, e) => s + e.debit, 0);
      const totalCredits = entries.reduce((s, e) => s + e.credit, 0);
      const closingBalance = openingBalance + totalCredits - totalDebits;
      const memberName = `${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim();

      return {
        memberNumber: dto.memberNumber,
        memberName,
        headCode: dto.headCode,
        headName,
        fromDate: dto.fromDate,
        toDate: dto.toDate,
        openingBalance,
        totalDebits,
        totalCredits,
        closingBalance,
        entries,
        totalTransactions: entries.length,
      };

    } catch (error) {
      this.logger.error('Error generating member ledger report:', error);
      if (error instanceof NotFoundException) throw error;
      throw new Error('Failed to generate member ledger report');
    }
  }

  async getMemberDetailLedgerReport(dto: GetMemberDetailLedgerDto): Promise<MemberDetailLedgerSummaryDto> {
    try {
      const memberNumberStr = dto.memberNumber.toString();

      // Member + office info
      const memberResult = await this.ledgerRepository.query(`
        SELECT
          TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.m_name,'') || ' ' || COALESCE(m.l_name,'')) AS member_name,
          m.officeno,
          COALESCE(d.name, m.officeno::text) AS office_name
        FROM member_master m
        LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
        WHERE m.mbno = $1
      `, [memberNumberStr]);

      if (!memberResult.length) throw new NotFoundException(`Member ${dto.memberNumber} not found`);
      const { member_name, officeno, office_name } = memberResult[0];

      // In-range transactions (deduped by ledgerid)
      const rawEntries = await this.ledgerRepository.query(`
        SELECT DISTINCT ON (l.ledgerid)
          l.ledgerid, l.trans_date, l.code,
          COALESCE(ab.acname, l.code) AS head_name,
          COALESCE(l.receipt_vchr_no, '') AS voucher_no,
          COALESCE(l.narration, '') AS narration,
          l.trans_type,
          CAST(l.trans_amt AS numeric) AS amount
        FROM ledger l
        LEFT JOIN accountbalance ab ON ab.acno = l.code
        WHERE CAST(l.mbno AS text) = $1
          AND l.trans_date::date >= $2::date
          AND l.trans_date::date <= $3::date
        ORDER BY l.ledgerid, l.trans_date
      `, [memberNumberStr, dto.fromDate, dto.toDate]);

      // Opening balance per account code (all activity before fromDate)
      const openingRows = await this.ledgerRepository.query(`
        SELECT code,
          SUM(CASE WHEN trans_type='CR' THEN CAST(trans_amt AS numeric) ELSE 0 END) AS total_cr,
          SUM(CASE WHEN trans_type='DR' THEN CAST(trans_amt AS numeric) ELSE 0 END) AS total_dr
        FROM (
          SELECT DISTINCT ON (ledgerid) ledgerid, code, trans_type, trans_amt
          FROM ledger
          WHERE CAST(mbno AS TEXT) = $1 AND trans_date::date < $2::date
          ORDER BY ledgerid
        ) t GROUP BY code
      `, [memberNumberStr, dto.fromDate]);

      const openingByCode: Record<string, number> = {};
      for (const r of openingRows) {
        openingByCode[r.code] = (parseFloat(r.total_cr) || 0) - (parseFloat(r.total_dr) || 0);
      }

      const entries = rawEntries.map((r: any) => {
        const amt = parseFloat(r.amount) || 0;
        return {
          date: r.trans_date,
          accountHead: r.head_name,
          voucherNo: r.voucher_no,
          particulars: r.narration,
          debit: r.trans_type === 'DR' ? amt : 0,
          credit: r.trans_type === 'CR' ? amt : 0,
          code: r.code,
        };
      });

      const totalDebits = entries.reduce((s: number, e: any) => s + e.debit, 0);
      const totalCredits = entries.reduce((s: number, e: any) => s + e.credit, 0);

      return {
        memberNumber: dto.memberNumber,
        memberName: member_name,
        officeNo: officeno,
        officeName: office_name,
        fromDate: dto.fromDate,
        toDate: dto.toDate,
        openingByCode,
        entries,
        totalDebits,
        totalCredits,
      };
    } catch (error) {
      this.logger.error('Error generating member detail ledger:', error);
      if (error instanceof NotFoundException) throw error;
      throw new Error('Failed to generate member detail ledger report');
    }
  }

  /**
   * Legacy "MEMBER DETAIL LEDGER" — pivots the 4 member-facing accounts into columns
   * (SHARE / LONG TERM LOAN / EMERGENCY LOAN / COMPULSORY DEPOSIT) with per-date Dr/Cr/Bal,
   * an opening balance row, and closing balances.
   * Sign: loans (A1002/A1047) show outstanding (Dr - Cr); share/CD show balance (Cr - Dr).
   */
  async getMemberColumnarLedger(dto: GetMemberDetailLedgerDto): Promise<MemberColumnarLedgerDto> {
    try {
      const memberNumberStr = dto.memberNumber.toString();
      const member = await this.memberRepository.findOne({ where: { mbno: memberNumberStr } });
      if (!member) throw new NotFoundException(`Member ${dto.memberNumber} not found`);

      const codes = ['L1001', 'A1002', 'A1047', 'L1004'];
      const isLoan = (code: string) => code === 'A1002' || code === 'A1047';
      const signed = (code: string, dr: number, cr: number) => (isLoan(code) ? dr - cr : cr - dr);

      // Opening balances: signed sum of all activity before fromDate (deduped by ledgerid)
      const openingRows = await this.ledgerRepository.query(`
        SELECT code,
          SUM(CASE WHEN trans_type='DR' THEN amt ELSE 0 END) AS dr,
          SUM(CASE WHEN trans_type='CR' THEN amt ELSE 0 END) AS cr
        FROM (
          SELECT DISTINCT ON (ledgerid) ledgerid, code, trans_type, CAST(trans_amt AS numeric) AS amt
          FROM ledger
          WHERE CAST(mbno AS text) = $1 AND code = ANY($2::text[]) AND trans_date::date < $3::date
          ORDER BY ledgerid
        ) t GROUP BY code
      `, [memberNumberStr, codes, dto.fromDate]);

      // In-range activity: per date, per code (deduped by ledgerid)
      const txRows = await this.ledgerRepository.query(`
        SELECT trans_date::date AS dt, code,
          SUM(CASE WHEN trans_type='DR' THEN amt ELSE 0 END) AS dr,
          SUM(CASE WHEN trans_type='CR' THEN amt ELSE 0 END) AS cr
        FROM (
          SELECT DISTINCT ON (ledgerid) ledgerid, trans_date, code, trans_type, CAST(trans_amt AS numeric) AS amt
          FROM ledger
          WHERE CAST(mbno AS text) = $1 AND code = ANY($2::text[])
            AND trans_date::date >= $3::date AND trans_date::date <= $4::date
          ORDER BY ledgerid
        ) t GROUP BY trans_date::date, code ORDER BY dt
      `, [memberNumberStr, codes, dto.fromDate, dto.toDate]);

      const opening: Record<string, number> = { L1001: 0, A1002: 0, A1047: 0, L1004: 0 };
      for (const r of openingRows) {
        opening[r.code] = signed(r.code, parseFloat(r.dr) || 0, parseFloat(r.cr) || 0);
      }
      const running: Record<string, number> = { ...opening };

      // Group in-range rows by date, preserving ascending date order
      const dateOrder: string[] = [];
      const byDate: Record<string, Record<string, { dr: number; cr: number }>> = {};
      for (const r of txRows) {
        const d = r.dt instanceof Date ? r.dt.toISOString().slice(0, 10) : String(r.dt).slice(0, 10);
        if (!byDate[d]) { byDate[d] = {}; dateOrder.push(d); }
        byDate[d][r.code] = { dr: parseFloat(r.dr) || 0, cr: parseFloat(r.cr) || 0 };
      }

      const mkCell = (code: string, cell?: { dr: number; cr: number }) => {
        if (cell && (cell.dr !== 0 || cell.cr !== 0)) {
          running[code] += signed(code, cell.dr, cell.cr);
          return { dr: cell.dr, cr: cell.cr, bal: running[code] };
        }
        return { dr: 0, cr: 0, bal: null };
      };

      const rows = dateOrder.map((d) => {
        const m = byDate[d];
        return {
          date: d,
          share: mkCell('L1001', m['L1001']),
          ltl: mkCell('A1002', m['A1002']),
          emer: mkCell('A1047', m['A1047']),
          cd: mkCell('L1004', m['L1004']),
        };
      });

      const memberName = `${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim();

      return {
        memberNumber: dto.memberNumber,
        memberName,
        fromDate: dto.fromDate,
        toDate: dto.toDate,
        opening: { share: opening.L1001, ltl: opening.A1002, emer: opening.A1047, cd: opening.L1004 },
        closing: { share: running.L1001, ltl: running.A1002, emer: running.A1047, cd: running.L1004 },
        rows,
      };
    } catch (error) {
      this.logger.error('Error generating columnar member ledger:', error);
      if (error instanceof NotFoundException) throw error;
      throw new Error('Failed to generate columnar member ledger');
    }
  }

  async validateMember(dto: ValidateMemberDto): Promise<{ exists: boolean; memberName?: string; memberNumber: string }> {
    try {
      const member = await this.memberRepository.findOne({ where: { mbno: dto.memberNumber.toString() } });
      if (member) {
        return {
          exists: true,
          memberName: `${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim(),
          memberNumber: dto.memberNumber,
        };
      }
      return { exists: false, memberNumber: dto.memberNumber };
    } catch (error) {
      this.logger.error('Error validating member:', error);
      return { exists: false, memberNumber: dto.memberNumber };
    }
  }

  async getHeadMasters(): Promise<HeadMasterDto[]> {
    try {
      // Use accountbalance for proper names (preferred over head_master's 20 generic rows)
      const rows = await this.ledgerRepository.query(`
        SELECT acno AS code, acname AS head_name
        FROM accountbalance
        WHERE acno IS NOT NULL AND TRIM(acno) != ''
        ORDER BY acno
      `);
      return rows.map((r: any) => ({ code: r.code, headName: r.head_name || r.code }));
    } catch (error) {
      this.logger.error('Error fetching head masters:', error);
      return [];
    }
  }
}
