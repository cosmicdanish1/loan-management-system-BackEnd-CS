import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DataSource } from 'typeorm';
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
  MemberDetailLedgerSummaryDto
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
    private headMasterRepository: Repository<HeadMaster>,
    private dataSource: DataSource
  ) { }

  async getMemberLedgerReport(dto: GetMemberLedgerDto): Promise<MemberLedgerSummaryDto> {
    try {
      // Keep memberNumber as string to match database numeric type
      const memberNumberStr = dto.memberNumber.toString();
      const fromDate = new Date(dto.fromDate);
      const toDate = new Date(dto.toDate);

      // Set time boundaries
      const startOfDay = new Date(fromDate);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(toDate);
      endOfDay.setHours(23, 59, 59, 999);

      // Validate member exists - use string comparison for numeric column
      const member = await this.memberRepository.findOne({
        where: { mbno: memberNumberStr }
      });

      if (!member) {
        throw new NotFoundException(`Member with number ${dto.memberNumber} not found`);
      }

      // Get head name
      const headMaster = await this.headMasterRepository.findOne({
        where: { code: dto.headCode }
      });

      const headName = headMaster?.head_name || dto.headCode;

      // Get ledger entries for the member, head, and date range
      // FIX: Use string comparison for numeric mbno column
      const ledgerEntries = await this.ledgerRepository
        .createQueryBuilder('l')
        .where('l.mbno = :memberNumber', { memberNumber: memberNumberStr })
        .andWhere('l.code = :headCode', { headCode: dto.headCode })
        .andWhere('l.trans_date >= :startDate AND l.trans_date <= :endDate', {
          startDate: startOfDay,
          endDate: endOfDay
        })
        .orderBy('l.trans_date', 'ASC')
        .addOrderBy('l.trans_no', 'ASC')
        .getMany();

      // Calculate opening balance (transactions before the from date)
      const openingBalance = await this.calculateOpeningBalance(
        memberNumberStr,
        dto.headCode,
        startOfDay
      );

      // Transform ledger entries
      let runningBalance = openingBalance;
      const entries: MemberLedgerEntryDto[] = ledgerEntries.map(entry => {
        const amount = this.parseMoneyAmount(entry.trans_amt.toString());

        // Update running balance
        if (entry.trans_type === 'CR') {
          runningBalance += amount;
        } else {
          runningBalance -= amount;
        }

        return {
          transactionNo: entry.trans_no,
          transactionDate: entry.trans_date,
          voucherNo: entry.receipt_vchr_no || '',
          narration: entry.narration || '',
          debit: entry.trans_type === 'DR' ? amount : 0,
          credit: entry.trans_type === 'CR' ? amount : 0,
          balance: runningBalance,
          transactionType: entry.trans_type as 'DR' | 'CR',
          username: entry.username || ''
        };
      });

      // Calculate totals
      const totalDebits = entries.reduce((sum, entry) => sum + entry.debit, 0);
      const totalCredits = entries.reduce((sum, entry) => sum + entry.credit, 0);
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
        totalTransactions: entries.length
      };

    } catch (error) {
      this.logger.error('Error generating member ledger report:', error);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new Error('Failed to generate member ledger report');
    }
  }

  async getMemberDetailLedgerReport(dto: GetMemberDetailLedgerDto): Promise<MemberDetailLedgerSummaryDto> {
    try {
      // Keep memberNumber as string to match database numeric type
      const memberNumberStr = dto.memberNumber.toString();
      const fromDate = new Date(dto.fromDate);
      const toDate = new Date(dto.toDate);

      const startOfDay = new Date(fromDate);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(toDate);
      endOfDay.setHours(23, 59, 59, 999);

      // Validate member - use string comparison for numeric column
      const member = await this.memberRepository.findOne({
        where: { mbno: memberNumberStr }
      });

      if (!member) {
        throw new NotFoundException(`Member with number ${dto.memberNumber} not found`);
      }

      // Query raw logic as requested:
      // Join ledger with headmaster to get head_name
      // Filter by member_code and date range
      // Order by trans_date, voucher_no
      // FIX: Use string comparison for numeric mbno column
      const rawEntries = await this.ledgerRepository
        .createQueryBuilder('l')
        .leftJoinAndMapOne('l.head', HeadMaster, 'h', 'l.code = h.code')
        .where('l.mbno = :memberNumber', { memberNumber: memberNumberStr })
        .andWhere('l.trans_date >= :startDate AND l.trans_date <= :endDate', {
          startDate: startOfDay,
          endDate: endOfDay
        })
        .orderBy('l.trans_date', 'ASC')
        .addOrderBy('l.receipt_vchr_no', 'ASC') // voucher_no
        .select([
          'l.trans_date',
          'h.head_name',
          'l.receipt_vchr_no',
          'l.narration',
          'l.trans_amt',
          'l.trans_type',
          'l.code', // head_code
          'l.acc_type'
        ])
        .getRawMany();

      const openingRows = await this.dataSource.query(`
        SELECT code, COALESCE(SUM(CASE WHEN trans_type = 'CR' THEN trans_amt ELSE -trans_amt END), 0) AS opening
        FROM ledger
        WHERE CAST(mbno AS text) = $1 AND trans_date < $2
        GROUP BY code
      `, [memberNumberStr, startOfDay]);
      const openingByCode: Record<string, number> = Object.fromEntries(
        openingRows.map((r: any) => [r.code, Number(r.opening) || 0]),
      );

      // Loan account balances are principal outstanding. The generic ledger
      // contains full EMI credits, so its credit-minus-debit running total is
      // not a loan balance. Reuse the component-based reconstruction used by
      // the columnar report and expose the per-date balance to this legacy UI.
      const columnar = await this.getMemberColumnarLedgerReport(dto);
      const balanceByDate = new Map<string, { ltl: number; emer: number }>();
      for (const row of columnar.rows) {
        balanceByDate.set(String(row.date), { ltl: Number(row.ltl.bal) || 0, emer: Number(row.emer.bal) || 0 });
      }
      const dateKey = (value: any) => new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(value));

      // Transform to DTO
      const entries = rawEntries.map(entry => {
        const amount = typeof entry.l_trans_amt === 'number' ? entry.l_trans_amt : parseFloat(entry.l_trans_amt);
        const debit = entry.l_trans_type === 'DR' ? amount : 0;
        const credit = entry.l_trans_type === 'CR' ? amount : 0;
        const isRegularLoan = entry.l_acc_type === 'RLN';
        const isEmergencyLoan = entry.l_acc_type === 'ALN' || entry.l_acc_type === 'ELN';
        const loanBalances = balanceByDate.get(dateKey(entry.l_trans_date));
        if (isRegularLoan) openingByCode[entry.l_code] = -columnar.opening.ltl;
        if (isEmergencyLoan) openingByCode[entry.l_code] = -columnar.opening.emer;

        return {
          date: entry.l_trans_date,
          accountHead: entry.h_head_name || 'Unknown Head',
          voucherNo: entry.l_receipt_vchr_no,
          particulars: entry.l_narration,
          debit: debit,
          credit: credit,
          code: entry.l_code,
          // Negative means outstanding debit balance in this legacy report.
          balance: isRegularLoan ? -(loanBalances?.ltl || 0) :
            isEmergencyLoan ? -(loanBalances?.emer || 0) : undefined,
        };
      });

      const totalDebits = entries.reduce((sum, e) => sum + e.debit, 0);
      const totalCredits = entries.reduce((sum, e) => sum + e.credit, 0);
      const memberName = `${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim();

      return {
        memberNumber: dto.memberNumber,
        memberName,
        fromDate: dto.fromDate,
        toDate: dto.toDate,
        openingByCode,
        entries,
        totalDebits,
        totalCredits
      };

    } catch (error) {
      this.logger.error('Error generating member detail ledger report:', error);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new Error('Failed to generate member detail ledger report');
    }
  }

  /**
   * Legacy four-column member ledger. Loan balances are reconstructed from
   * principal movements, not from the full EMI amount in `ledger`.
   */
  async getMemberColumnarLedgerReport(dto: GetMemberDetailLedgerDto): Promise<any> {
    const memberNo = dto.memberNumber.toString();
    const member = await this.memberRepository.findOne({ where: { mbno: memberNo } });
    if (!member) throw new NotFoundException(`Member with number ${dto.memberNumber} not found`);

    const start = dto.fromDate;
    const end = dto.toDate;
    const raw = await this.dataSource.query(`
      SELECT to_char(trans_date::date, 'YYYY-MM-DD') AS date_key, trans_type, trans_amt, acc_type, code
      FROM ledger
      WHERE CAST(mbno AS text) = $1 AND trans_date::date <= $2::date
      ORDER BY trans_date ASC, ledgerid ASC
    `, [memberNo, end]);
    const repayments = await this.dataSource.query(`
      SELECT to_char(r.payment_date::date, 'YYYY-MM-DD') AS date_key, r.principal_amount,
             l.loantype
      FROM loan_repayment_ledger r
      JOIN loan_master l ON CAST(l.loancaseno AS text) = CAST(r.loancaseno AS text)
      WHERE CAST(r.mbno AS text) = $1
    `, [memberNo]);
    const loanBalances = await this.dataSource.query(`
      SELECT loantype, COALESCE(SUM(CAST(balance AS numeric)), 0) AS balance
      FROM loan_master
      WHERE CAST(mbno AS text) = $1
      GROUP BY loantype
    `, [memberNo]);

    const currentLoan = (types: string[]) => loanBalances
      .filter((r: any) => types.includes(r.loantype))
      .reduce((sum: number, r: any) => sum + Number(r.balance || 0), 0);
    const loanEvents: Record<string, Array<{ date: string; effect: number }>> = { ltl: [], emer: [] };
    for (const row of raw) {
      const bucket = row.acc_type === 'RLN' ? 'ltl' : (row.acc_type === 'ALN' || row.acc_type === 'ELN' ? 'emer' : null);
      if (bucket && row.trans_type === 'DR') loanEvents[bucket].push({ date: row.date_key, effect: Number(row.trans_amt || 0) });
    }
    for (const row of repayments) {
      const bucket = row.loantype === 'RLN' ? 'ltl' : (row.loantype === 'ALN' || row.loantype === 'ELN' ? 'emer' : null);
      if (bucket) loanEvents[bucket].push({ date: row.date_key, effect: -(Number(row.principal_amount) || 0) });
    }

    const balanceAt = (bucket: 'ltl' | 'emer', date: string) => {
      const current = currentLoan(bucket === 'ltl' ? ['RLN'] : ['ALN', 'ELN']);
      const after = loanEvents[bucket].filter(e => e.date > date).reduce((sum, e) => sum + e.effect, 0);
      return Math.max(0, current - after);
    };
    const openingLoan = (bucket: 'ltl' | 'emer') => {
      const current = currentLoan(bucket === 'ltl' ? ['RLN'] : ['ALN', 'ELN']);
      const fromStart = loanEvents[bucket].filter(e => e.date >= start).reduce((sum, e) => sum + e.effect, 0);
      return Math.max(0, current - fromStart);
    };

    const dates = Array.from(new Set(raw.filter((r: any) => r.date_key >= start).map((r: any) => String(r.date_key)))).sort();
    const empty = () => ({ dr: 0, cr: 0, bal: null as number | null });
    const rows = dates.map(date => {
      const cells: any = { share: empty(), ltl: empty(), emer: empty(), cd: empty() };
      for (const item of raw.filter((r: any) => String(r.date_key) === date)) {
        const amount = Number(item.trans_amt || 0);
        const bucket = item.acc_type === 'SHR' ? 'share' : item.acc_type === 'RLN' ? 'ltl' :
          (item.acc_type === 'ALN' || item.acc_type === 'ELN') ? 'emer' : item.acc_type === 'CD' ? 'cd' : null;
        if (!bucket) continue;
        if (item.trans_type === 'DR') cells[bucket].dr += amount; else cells[bucket].cr += amount;
      }
      cells.ltl.bal = balanceAt('ltl', String(date));
      cells.emer.bal = balanceAt('emer', String(date));
      for (const bucket of ['share', 'cd'] as const) {
        const before = raw.filter((r: any) => String(r.date_key) <= date && (r.acc_type === (bucket === 'share' ? 'SHR' : 'CD')))
          .reduce((sum: number, r: any) => sum + (r.trans_type === 'CR' ? 1 : -1) * Number(r.trans_amt || 0), 0);
        cells[bucket].bal = before;
      }
      return { date, ...cells };
    });

    return {
      memberNumber: memberNo,
      memberName: `${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim(),
      fromDate: start, toDate: end,
      opening: { share: 0, ltl: openingLoan('ltl'), emer: openingLoan('emer'), cd: 0 },
      closing: {
        share: rows.length ? rows[rows.length - 1].share.bal : 0,
        ltl: balanceAt('ltl', end), emer: balanceAt('emer', end),
        cd: rows.length ? rows[rows.length - 1].cd.bal : 0,
      },
      rows,
    };
  }

  async validateMember(dto: ValidateMemberDto): Promise<{
    exists: boolean;
    memberName?: string;
    memberNumber: string;
  }> {
    try {
      // Use string comparison for numeric mbno column
      const memberNumberStr = dto.memberNumber.toString();
      const member = await this.memberRepository.findOne({
        where: { mbno: memberNumberStr }
      });

      if (member) {
        const memberName = `${member.f_name || ''} ${member.m_name || ''} ${member.l_name || ''}`.trim();
        return {
          exists: true,
          memberName,
          memberNumber: dto.memberNumber
        };
      }

      return {
        exists: false,
        memberNumber: dto.memberNumber
      };

    } catch (error) {
      this.logger.error('Error validating member:', error);
      return {
        exists: false,
        memberNumber: dto.memberNumber
      };
    }
  }

  async getHeadMasters(): Promise<HeadMasterDto[]> {
    try {
      const heads = await this.headMasterRepository
        .createQueryBuilder('h')
        .select(['h.code', 'h.head_name'])
        .orderBy('h.code', 'ASC')
        .getMany();

      return heads.map(head => ({
        code: head.code,
        headName: head.head_name || head.code
      }));

    } catch (error) {
      this.logger.error('Error fetching head masters:', error);
      return [];
    }
  }

  private async calculateOpeningBalance(
    memberNumberStr: string,
    headCode: string,
    beforeDate: Date
  ): Promise<number> {
    try {
      // FIX: Use string comparison for numeric mbno column
      const entries = await this.ledgerRepository
        .createQueryBuilder('l')
        .where('l.mbno = :memberNumber', { memberNumber: memberNumberStr })
        .andWhere('l.code = :headCode', { headCode })
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
