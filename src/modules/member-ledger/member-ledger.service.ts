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
    private headMasterRepository: Repository<HeadMaster>
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
          'l.code' // head_code
        ])
        .getRawMany();

      // Transform to DTO
      const entries = rawEntries.map(entry => {
        const amount = typeof entry.l_trans_amt === 'number' ? entry.l_trans_amt : parseFloat(entry.l_trans_amt);
        const debit = entry.l_trans_type === 'DR' ? amount : 0;
        const credit = entry.l_trans_type === 'CR' ? amount : 0;

        return {
          date: entry.l_trans_date,
          accountHead: entry.h_head_name || 'Unknown Head',
          voucherNo: entry.l_receipt_vchr_no,
          particulars: entry.l_narration,
          debit: debit,
          credit: credit,
          code: entry.l_code
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