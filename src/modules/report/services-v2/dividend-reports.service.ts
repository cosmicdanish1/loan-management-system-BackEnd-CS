import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Dividend Reports Service - Handles dividend and interest reports.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from report.service.ts for single responsibility
 */
@Injectable()
export class DividendReportsService {
  constructor(private readonly dataSource: DataSource) { }

  /**
   * Get dividend report
   */
  /**
   * Get dividend report
   */
  async getDividendReport(dto: { year: number; wingNo?: string; officeNo?: string; limit?: number; offset?: number }) {
    const { year, wingNo, officeNo, limit, offset } = dto;

    const baseQuery = `
      FROM member_master m
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      LEFT JOIN member_balances mb ON m.mbno = mb.mbno
      LEFT JOIN dividend_master div ON m.mbno = div.mbno AND div.year = $1
      WHERE m.isactive = 'Y' AND COALESCE(mb.shares, 0) > 0
    `;

    const params: any[] = [year];
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
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        COALESCE(mb.shares, 0) as share_balance,
        COALESCE(div.dividend_amount, 0) as dividend_amount,
        COALESCE(div.dividend_rate, 0) as dividend_rate
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
      data: result.map((r: any, idx: number) => ({
        key: ((offset || 0) + idx).toString(),
        memberNo: r.member_no,
        memberName: r.member_name,
        officeName: r.office_name,
        shareBalance: parseFloat(r.share_balance) || 0,
        dividendAmount: parseFloat(r.dividend_amount) || 0,
        dividendRate: parseFloat(r.dividend_rate) || 0
      }))
    };
  }

  /**
   * Get dividend paid report
   */
  async getDividendPaid(dto: { year: number; fromDate?: string; toDate?: string; limit?: number; offset?: number }) {
    const { year, fromDate, toDate, limit, offset } = dto;

    const baseQuery = `
      FROM dividend_master div
      LEFT JOIN member_master m ON m.mbno = div.mbno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE div.year = $1 AND div.is_paid = 'Y'
    `;

    const params: any[] = [year];
    let whereClause = '';

    if (fromDate) {
      whereClause += ` AND div.payment_date >= $${params.length + 1}`;
      params.push(fromDate);
    }

    if (toDate) {
      whereClause += ` AND div.payment_date <= $${params.length + 1}`;
      params.push(toDate);
    }

    // Get total count
    const totalCountRes = await this.dataSource.query(`SELECT COUNT(*) ${baseQuery} ${whereClause}`, params);
    const totalCount = parseInt(totalCountRes[0].count);

    let query = `
      SELECT 
        m.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        div.dividend_amount,
        div.payment_date,
        div.payment_mode,
        div.cheque_no
      ${baseQuery} ${whereClause}
      ORDER BY div.payment_date DESC
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
      data: result.map((r: any, idx: number) => ({
        key: ((offset || 0) + idx).toString(),
        memberNo: r.member_no,
        memberName: r.member_name,
        officeName: r.office_name,
        dividendAmount: parseFloat(r.dividend_amount) || 0,
        paymentDate: r.payment_date,
        paymentMode: r.payment_mode,
        chequeNo: r.cheque_no
      }))
    };
  }

  /**
   * Get dividend warrant
   */
  async getDividendWarrant(dto: { memberNo: string; year: number }) {
    const { memberNo, year } = dto;

    const query = `
      SELECT 
        m.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        m.present_address as address,
        d.name as office_name,
        COALESCE(mb.shares, 0) as share_balance,
        div.dividend_amount,
        div.dividend_rate,
        div.year,
        div.payment_date
      FROM member_master m
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      LEFT JOIN member_balances mb ON m.mbno = mb.mbno
      LEFT JOIN dividend_master div ON m.mbno = div.mbno AND div.year = $2
      WHERE m.mbno = $1
    `;

    const result = await this.dataSource.query(query, [memberNo, year]);

    if (result.length === 0) {
      return null;
    }

    const r = result[0];
    return {
      memberNo: r.member_no,
      memberName: r.member_name,
      address: r.address,
      officeName: r.office_name,
      shareBalance: parseFloat(r.share_balance) || 0,
      dividendAmount: parseFloat(r.dividend_amount) || 0,
      dividendRate: parseFloat(r.dividend_rate) || 0,
      year: r.year,
      paymentDate: r.payment_date
    };
  }

  /**
   * Get share warrant
   */
  async getShareWarrant(dto: { memberNo: string }) {
    const { memberNo } = dto;

    const query = `
      SELECT 
        m.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        m.present_address as address,
        m.memb_date as membership_date,
        d.name as office_name,
        COALESCE(mb.shares, 0) as share_balance
      FROM member_master m
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      LEFT JOIN member_balances mb ON m.mbno = mb.mbno
      WHERE m.mbno = $1
    `;

    const result = await this.dataSource.query(query, [memberNo]);

    if (result.length === 0) {
      return null;
    }

    const r = result[0];
    return {
      memberNo: r.member_no,
      memberName: r.member_name,
      address: r.address,
      membershipDate: r.membership_date,
      officeName: r.office_name,
      shareBalance: parseFloat(r.share_balance) || 0
    };
  }

  /**
   * Get interest list
   */
  async getInterestList(dto: { year: number; type?: string; limit?: number; offset?: number }) {
    const { year, type, limit, offset } = dto;

    const baseQuery = `
      FROM interest_ledger il
      LEFT JOIN member_master m ON m.mbno = il.mbno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE EXTRACT(YEAR FROM il.to_date) = $1
    `;

    const params: any[] = [year];
    let whereClause = '';

    if (type) {
      whereClause += ` AND il.deposit_type = $${params.length + 1}`;
      params.push(type);
    }

    // Get total count
    const totalCountRes = await this.dataSource.query(`SELECT COUNT(*) ${baseQuery} ${whereClause}`, params);
    const totalCount = parseInt(totalCountRes[0].count);

    let query = `
      SELECT 
        m.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        il.deposit_type,
        il.principal_amount,
        il.interest_amount,
        il.interest_rate,
        il.from_date,
        il.to_date
      ${baseQuery} ${whereClause}
      ORDER BY il.to_date DESC, m.mbno
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
      data: result.map((r: any, idx: number) => ({
        key: ((offset || 0) + idx).toString(),
        memberNo: r.member_no,
        memberName: r.member_name,
        officeName: r.office_name,
        depositType: r.deposit_type,
        principalAmount: parseFloat(r.principal_amount) || 0,
        interestAmount: parseFloat(r.interest_amount) || 0,
        interestRate: parseFloat(r.interest_rate) || 0,
        fromDate: r.from_date,
        toDate: r.to_date
      }))
    };
  }

  /**
   * Get interest certificate
   */
  async getInterestCertificate(dto: { memberNo: string; year: number }) {
    const { memberNo, year } = dto;

    const query = `
      SELECT 
        m.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        m.pfno as pf_no,
        d.name as office_name,
        SUM(COALESCE(il.interest_amount, 0)) as total_interest
      FROM member_master m
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      LEFT JOIN interest_ledger il ON m.mbno = il.mbno AND EXTRACT(YEAR FROM il.to_date) = $2
      WHERE m.mbno = $1
      GROUP BY m.mbno, m.f_name, m.m_name, m.l_name, m.pfno, d.name
    `;

    const result = await this.dataSource.query(query, [memberNo, year]);

    if (result.length === 0) {
      return null;
    }

    const r = result[0];
    return {
      memberNo: r.member_no,
      memberName: r.member_name,
      pfNo: r.pf_no,
      officeName: r.office_name,
      year: year,
      totalInterest: parseFloat(r.total_interest) || 0
    };
  }
}
