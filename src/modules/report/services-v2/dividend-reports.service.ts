import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { parseSafeDate } from '../../shared/utils/date-utils';

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
  async getDividendReport(dto: { year: number; wingNo?: string; officeNo?: string; dividendRate?: number; limit?: number; offset?: number }) {
    const { year, wingNo, officeNo, dividendRate = 10, limit, offset } = dto;

    const baseQuery = `
      FROM member_master m
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      LEFT JOIN member_balances mb ON m.mbno = mb.mbno
      LEFT JOIN dividend_master div ON m.mbno::text = div.mbno AND div.year = $1
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

    // Add dividendRate to params for the main query
    const dividendRateParamIndex = params.length + 1;
    params.push(dividendRate);

    let query = `
      SELECT 
        m.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        m.desig as designation,
        d.name as office_name,
        COALESCE(mb.shares, 0) as share_balance,
        COALESCE(div.dividend_amount, COALESCE(mb.shares, 0) * $${dividendRateParamIndex} / 100) as dividend_amount,
        COALESCE(div.dividend_rate, $${dividendRateParamIndex}) as dividend_rate
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
      success: true,
      metadata: {
        totalCount,
        limit: limit || totalCount,
        offset: offset || 0
      },
      data: result.map((r: any, idx: number) => ({
        key: ((offset || 0) + idx).toString(),
        memberNo: r.member_no,
        memberName: r.member_name,
        wing: r.office_name,
        office: r.office_name,
        designation: r.designation || '',
        shareAmount: parseFloat(r.share_balance) || 0,
        dividendAmount: parseFloat(r.dividend_amount) || 0,
        dividendRate: parseFloat(r.dividend_rate) || 0
      }))
    };
  }

  /**
   * Get dividend paid report
   */
  async getDividendPaid(dto: { year: number; wingNo?: string; fromDate?: string; toDate?: string; limit?: number; offset?: number }) {
    const { year, wingNo, fromDate, toDate, limit, offset } = dto;

    const baseQuery = `
      FROM dividend_master div
      LEFT JOIN member_master m ON m.mbno::text = div.mbno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE div.is_paid = 'Y'
    `;

    const params: any[] = [];
    let whereClause = '';

    // If year is provided but no dates, we could use year, but dates are preferred for strict ranges
    if (!fromDate && !toDate) {
      whereClause += ` AND div.year = $${params.length + 1}`;
      params.push(year);
    }

    if (fromDate) {
      whereClause += ` AND div.payment_date >= $${params.length + 1}`;
      params.push(parseSafeDate(fromDate));
    }

    if (toDate) {
      whereClause += ` AND div.payment_date <= $${params.length + 1}`;
      params.push(parseSafeDate(toDate));
    }

    if (wingNo) {
      whereClause += ` AND m.wingno = $${params.length + 1}`;
      params.push(wingNo);
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
        div.cheque_no,
        div.voucher_no
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
        chequeNo: r.cheque_no,
        voucherNo: r.voucher_no
      }))
    };
  }

  /**
   * Get dividend warrant
   */
  async getDividendWarrant(dto: { memberNo?: string; year: number; wingNo?: string; officeNo?: string; fromDate?: string; toDate?: string }) {
    const { memberNo, year, wingNo, officeNo, fromDate, toDate } = dto;

    const baseQuery = `
      FROM dividend_master div
      JOIN member_master m ON m.mbno::text = div.mbno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      LEFT JOIN member_balances mb ON m.mbno = mb.mbno
      WHERE div.year = $1
    `;

    const params: any[] = [year];
    let whereClause = '';

    if (memberNo) {
      whereClause += ` AND m.mbno = $${params.length + 1}`;
      params.push(memberNo);
    }

    if (wingNo) {
      whereClause += ` AND m.wingno = $${params.length + 1}`;
      params.push(wingNo);
    }

    if (officeNo) {
      whereClause += ` AND m.officeno = $${params.length + 1}`;
      params.push(officeNo);
    }

    if (fromDate) {
      whereClause += ` AND div.payment_date >= $${params.length + 1}`;
      params.push(parseSafeDate(fromDate));
    }

    if (toDate) {
      whereClause += ` AND div.payment_date <= $${params.length + 1}`;
      params.push(parseSafeDate(toDate));
    }

    const query = `
      SELECT 
        m.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        m.present_address as address,
        d.name as office_name,
        COALESCE(mb.shares, 0) as share_balance,
        div.dividend_amount,
        div.dividend_rate,
        div.cheque_no,
        div.year,
        div.payment_date
      ${baseQuery} ${whereClause}
      ORDER BY m.mbno
    `;

    const result = await this.dataSource.query(query, params);

    return {
      data: result.map((r: any) => ({
        memberNo: r.member_no,
        memberName: r.member_name,
        address: r.address,
        officeName: r.office_name,
        shareBalance: parseFloat(r.share_balance) || 0,
        dividendAmount: parseFloat(r.dividend_amount) || 0,
        dividendRate: parseFloat(r.dividend_rate) || 0,
        chequeNo: r.cheque_no,
        year: r.year,
        paymentDate: r.payment_date
      }))
    };
  }

  /**
   * Get share warrant
   */
  async getShareWarrant(dto: { memberFrom: string; memberTo: string; warrantDate?: string }) {
    let { memberFrom, memberTo, warrantDate } = dto;
    
    // Swap memberFrom and memberTo if they are in wrong order
    if (memberFrom && memberTo) {
      const fromNum = parseFloat(memberFrom);
      const toNum = parseFloat(memberTo);
      if (fromNum > toNum) {
        [memberFrom, memberTo] = [memberTo, memberFrom];
      }
    }
    
    const date = parseSafeDate(warrantDate);

    const query = `
      SELECT 
        mb.srno as "srno",
        mb.mbno as "mbno",
        mb.member_name as "memberName",
        mb.pfno as "pfno",
        mb.officeno as "officeno",
        mb.shares as "shareAmount",
        $3 as "warrantDate"
      FROM member_balances mb
      WHERE mb.mbno::numeric >= $1 AND mb.mbno::numeric <= $2
      AND mb.shares > 0
      ORDER BY mb.mbno::numeric ASC
    `;

    const result = await this.dataSource.query(query, [memberFrom, memberTo, date]);

    return result.map((item, index) => ({
      key: index.toString(),
      srno: (index + 1).toString(),
      mbno: item.mbno,
      memberName: item.memberName || 'Unknown',
      pfno: item.pfno || '-',
      officeno: item.officeno || '-',
      shareAmount: parseFloat(item.shareAmount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 }),
      warrantDate: item.warrantDate
    }));
  }

  /**
   * Get interest list
   */
  async getInterestList(dto: { year: number; type?: string; wingNo?: string; limit?: number; offset?: number }) {
    const { year, type, wingNo, limit, offset } = dto;

    // Use interestpaid table
    // BUG FIX: `m.mbno = ip.mbno::text` compared numeric (m.mbno) to text
    // (ip.mbno::text) — live-confirmed crash: "operator does not exist:
    // numeric = text", on every single call regardless of year. Both columns
    // are numeric (confirmed via information_schema), so cast neither.
    const baseQuery = `
      FROM interestpaid ip
      LEFT JOIN member_master m ON m.mbno = ip.mbno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE EXTRACT(YEAR FROM ip.paydate) = $1
    `;

    const params: any[] = [year];
    let whereClause = '';

    if (wingNo) {
      whereClause += ` AND m.wingno = $${params.length + 1}`;
      params.push(wingNo);
    }

    // Get total count
    const totalCountRes = await this.dataSource.query(`SELECT COUNT(*) ${baseQuery} ${whereClause}`, params);
    const totalCount = parseInt(totalCountRes[0].count);

    let query = `
      SELECT 
        m.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        ip.account_number,
        ip.interest as interest_amount,
        ip.paydate,
        ip.opbal as principal_amount
      ${baseQuery} ${whereClause}
      ORDER BY ip.paydate DESC, m.mbno
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
        depositType: 'DEPOSIT',
        principalAmount: parseFloat(r.principal_amount) || 0,
        interestAmount: parseFloat(r.interest_amount) || 0,
        fromDate: r.paydate,
        toDate: r.paydate
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
