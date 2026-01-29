import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Member Reports Service - Handles member-focused reports.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from report.service.ts for single responsibility
 */
@Injectable()
export class MemberReportsService {
  constructor(private readonly dataSource: DataSource) { }

  /**
   * Get member profile details
   */
  async getMemberProfile(dto: { memberNo: string }) {
    const { memberNo } = dto;

    const query = `
      SELECT 
        m.mbno, m.f_name, m.m_name, m.l_name, m.desig, m.present_address, m.dob, m.dor, m.pfno, m.basic_pay,
        m.nominee_name, m.nominee_address, m.nominee_relation, m.isactive,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as full_name,
        d.name as office_name,
        COALESCE(mb.shares, 0) as share_balance,
        COALESCE(mb.compulsory_deposit, 0) as cd_balance,
        COALESCE(mb.regularloan, 0) as regular_loan,
        COALESCE(mb.emergency_loan_balance, 0) as emergency_loan
      FROM member_master m
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      LEFT JOIN member_balances mb ON m.mbno = mb.mbno
      WHERE m.mbno = $1
    `;

    const result = await this.dataSource.query(query, [memberNo]);

    if (result.length === 0) {
      return null;
    }

    const member = result[0];
    return {
      memberNo: member.mbno,
      fullName: member.full_name,
      officeName: member.office_name,
      designation: member.desig,
      address: member.present_address,
      dateOfBirth: member.dob,
      dateOfRetirement: member.dor,
      pfNo: member.pfno,
      basicPay: member.basic_pay,
      nominee: {
        name: member.nominee_name,
        address: member.nominee_address,
        relation: member.nominee_relation
      },
      balances: {
        shares: parseFloat(member.share_balance) || 0,
        compulsoryDeposit: parseFloat(member.cd_balance) || 0,
        regularLoan: parseFloat(member.regular_loan) || 0,
        emergencyLoan: parseFloat(member.emergency_loan) || 0
      },
      isActive: member.isactive === 'Y'
    };
  }

  /**
   * Get member statement
   */
  async getMemberStatement(dto: { memberNo: string; fromDate?: string; toDate?: string; limit?: number; offset?: number }) {
    const { memberNo, fromDate, toDate, limit, offset } = dto;

    // Get member info
    const memberQuery = `
      SELECT 
        m.mbno,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name
      FROM member_master m
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE m.mbno = $1
    `;
    const memberResult = await this.dataSource.query(memberQuery, [memberNo]);

    if (memberResult.length === 0) {
      return null;
    }

    const member = memberResult[0];

    // Get total count for pagination
    let countQuery = `SELECT COUNT(*) FROM ledger WHERE mbno = $1`;
    const countParams: any[] = [memberNo];
    if (fromDate) {
      countQuery += ` AND trans_date >= $${countParams.length + 1}`;
      countParams.push(fromDate);
    }
    if (toDate) {
      countQuery += ` AND trans_date <= $${countParams.length + 1}`;
      countParams.push(toDate);
    }
    const totalCountRes = await this.dataSource.query(countQuery, countParams);
    const totalCount = parseInt(totalCountRes[0].count);

    // Get transactions
    let transactionQuery = `
      SELECT 
        trans_date as date,
        trans_type as type,
        code,
        trans_amt as amount,
        narration,
        receipt_vchr_no as voucher_no
      FROM ledger
      WHERE mbno = $1
    `;

    const params: any[] = [memberNo];

    if (fromDate) {
      transactionQuery += ` AND trans_date >= $${params.length + 1}`;
      params.push(fromDate);
    }

    if (toDate) {
      transactionQuery += ` AND trans_date <= $${params.length + 1}`;
      params.push(toDate);
    }

    transactionQuery += ` ORDER BY trans_date ASC, trans_no ASC`;

    if (limit !== undefined) {
      transactionQuery += ` LIMIT $${params.length + 1}`;
      params.push(limit);
    }

    if (offset !== undefined) {
      transactionQuery += ` OFFSET $${params.length + 1}`;
      params.push(offset);
    }

    const transactions = await this.dataSource.query(transactionQuery, params);

    return {
      metadata: {
        totalCount,
        limit: limit || totalCount,
        offset: offset || 0
      },
      memberNo: member.mbno,
      memberName: member.member_name,
      officeName: member.office_name,
      fromDate: fromDate || 'Start',
      toDate: toDate || 'End',
      transactions: transactions.map((t: any, idx: number) => ({
        key: (offset || 0 + idx).toString(),
        date: t.date,
        type: t.type,
        code: t.code,
        amount: parseFloat(t.amount) || 0,
        narration: t.narration,
        voucherNo: t.voucher_no
      }))
    };
  }

  /**
   * Get voters list
   */
  async getVotersList(dto: { wingNo?: string; officeNo?: string; limit?: number; offset?: number }) {
    const { wingNo, officeNo, limit, offset } = dto;

    let baseQuery = `
      FROM member_master m
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      LEFT JOIN member_balances mb ON m.mbno = mb.mbno
      WHERE m.isactive = 'Y'
    `;

    const params: any[] = [];
    let whereClause = '';

    if (wingNo) {
      whereClause += ` AND m.wingno = $${params.length + 1}`;
      params.push(wingNo);
    }

    if (officeNo) {
      whereClause += ` AND m.officeno = $${params.length + 1}`;
      params.push(officeNo);
    }

    // Get total count
    const totalCountRes = await this.dataSource.query(`SELECT COUNT(*) ${baseQuery} ${whereClause}`, params);
    const totalCount = parseInt(totalCountRes[0].count);

    let query = `
      SELECT 
        m.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        m.desig as designation,
        d.name as office_name,
        m.memb_date as membership_date,
        COALESCE(mb.shares, 0) as share_balance
      ${baseQuery} ${whereClause}
      ORDER BY m.mbno
    `;

    const queryParams = [...params];
    if (limit !== undefined) {
      query += ` LIMIT $${queryParams.length + 1}`;
      queryParams.push(limit);
    }

    if (offset !== undefined) {
      query += ` OFFSET $${queryParams.length + 1}`;
      queryParams.push(offset);
    }

    const result = await this.dataSource.query(query, queryParams);

    return {
      metadata: {
        totalCount,
        limit: limit || totalCount,
        offset: offset || 0
      },
      data: result.map((m: any, idx: number) => ({
        key: ((offset || 0) + idx).toString(),
        memberNo: m.member_no,
        memberName: m.member_name,
        designation: m.designation,
        officeName: m.office_name,
        membershipDate: m.membership_date,
        shareBalance: parseFloat(m.share_balance) || 0
      }))
    };
  }

  /**
   * Get member balance range report (members with balance in a range)
   */
  async getMemberBalanceRangeReport(dto: { minBalance: number; maxBalance: number; limit?: number; offset?: number }) {
    const { minBalance, maxBalance, limit, offset } = dto;

    const baseQuery = `
      FROM member_master m
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      LEFT JOIN member_balances mb ON m.mbno = mb.mbno
      WHERE m.isactive = 'Y'
        AND (COALESCE(mb.shares, 0) + COALESCE(mb.compulsory_deposit, 0)) >= $1
        AND (COALESCE(mb.shares, 0) + COALESCE(mb.compulsory_deposit, 0)) <= $2
    `;

    // Get total count
    const totalCountRes = await this.dataSource.query(`SELECT COUNT(*) ${baseQuery}`, [minBalance, maxBalance]);
    const totalCount = parseInt(totalCountRes[0].count);

    let query = `
      SELECT 
        m.mbno,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        (COALESCE(mb.shares, 0) + COALESCE(mb.compulsory_deposit, 0)) as total_balance
      ${baseQuery}
      ORDER BY (COALESCE(mb.shares, 0) + COALESCE(mb.compulsory_deposit, 0)) DESC
    `;

    const params: any[] = [minBalance, maxBalance];
    if (limit !== undefined) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(limit);
    }

    if (offset !== undefined) {
      query += ` OFFSET $${params.length + 1}`;
      params.push(offset);
    }

    const result = await this.dataSource.query(query, params);

    return {
      metadata: {
        totalCount,
        limit: limit || totalCount,
        offset: offset || 0
      },
      data: result.map((m: any, idx: number) => ({
        key: ((offset || 0) + idx).toString(),
        memberNo: m.mbno,
        memberName: m.member_name,
        officeName: m.office_name,
        totalBalance: parseFloat(m.total_balance) || 0
      }))
    };
  }

  /**
   * Get annual member statement
   */
  async getAnnualMemberStatement(dto: { memberNo: string; year: number; limit?: number; offset?: number }) {
    const { memberNo, year, limit, offset } = dto;

    const fromDate = `${year}-04-01`; // Financial year start
    const toDate = `${year + 1}-03-31`; // Financial year end

    return this.getMemberStatement({ memberNo, fromDate, toDate, limit, offset });
  }

  /**
   * Get jotting report (quick summary)
   */
  async getJottingReport(dto: { wingNo?: string; officeNo?: string; loanType?: string; limit?: number; offset?: number }) {
    const { wingNo, officeNo, loanType, limit, offset } = dto;

    const baseQuery = `
      FROM member_master m
      LEFT JOIN member_balances mb ON m.mbno = mb.mbno
      WHERE m.isactive = 'Y'
    `;

    const params: any[] = [];
    let whereClause = '';

    if (wingNo) {
      whereClause += ` AND m.wingno = $${params.length + 1}`;
      params.push(wingNo);
    }

    if (officeNo) {
      whereClause += ` AND m.officeno = $${params.length + 1}`;
      params.push(officeNo);
    }

    // Get total count
    const totalCountRes = await this.dataSource.query(`SELECT COUNT(*) ${baseQuery} ${whereClause}`, params);
    const totalCount = parseInt(totalCountRes[0].count);

    let query = `
      SELECT 
        m.mbno,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        COALESCE(mb.shares, 0) as shares,
        COALESCE(mb.compulsory_deposit, 0) as cd,
        COALESCE(mb.regularloan, 0) as regular_loan,
        COALESCE(mb.emergency_loan_balance, 0) as emergency_loan
      ${baseQuery} ${whereClause}
      ORDER BY m.mbno
    `;

    const queryParams = [...params];
    const finalLimit = limit || 500; // Default to 500 if not specified
    query += ` LIMIT $${queryParams.length + 1}`;
    queryParams.push(finalLimit);

    if (offset !== undefined) {
      query += ` OFFSET $${queryParams.length + 1}`;
      queryParams.push(offset);
    }

    const result = await this.dataSource.query(query, queryParams);

    return {
      metadata: {
        totalCount,
        limit: finalLimit,
        offset: offset || 0
      },
      data: result.map((m: any, idx: number) => ({
        key: ((offset || 0) + idx).toString(),
        memberNo: m.mbno,
        memberName: m.member_name,
        shares: parseFloat(m.shares) || 0,
        compulsoryDeposit: parseFloat(m.cd) || 0,
        regularLoan: parseFloat(m.regular_loan) || 0,
        emergencyLoan: parseFloat(m.emergency_loan) || 0
      }))
    };
  }
}
