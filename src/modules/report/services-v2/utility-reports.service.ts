import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialSummaryDto } from '../dto/financial-summary.dto';
import { parseSafeDate } from '../../shared/utils/date-utils';

/**
 * Utility Reports Service - Handles utility and miscellaneous reports.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from report.service.ts for single responsibility
 */
@Injectable()
export class UtilityReportsService {
  private readonly logger = new Logger(UtilityReportsService.name);

  constructor(private readonly dataSource: DataSource) { }

  /**
   * Get wing list
   */
  async getWingList() {
    const result = await this.dataSource.query(`
      SELECT DISTINCT wingno, MAX(name) as name
      FROM division_master
      WHERE wingno IS NOT NULL
      GROUP BY wingno
      ORDER BY wingno
    `);

    return result.map((w: any) => ({
      wingNo: w.wingno,
      name: w.name
    }));
  }

  /**
   * Get office list (division list)
   */
  async getOfficeList(wingNo?: string) {
    let query = `
      SELECT officeno, wingno, name
      FROM division_master
      WHERE officeno IS NOT NULL
    `;

    const params: any[] = [];

    if (wingNo) {
      query += ` AND wingno = $1`;
      params.push(wingNo);
    }

    query += ` ORDER BY name`;

    const result = await this.dataSource.query(query, params);

    return result.map((o: any) => ({
      officeNo: o.officeno,
      wingNo: o.wingno,
      name: o.name
    }));
  }

  /**
   * Get division list (alias for office list)
   */
  async getDivisionList(wingNo?: string) {
    return this.getOfficeList(wingNo);
  }

  /**
   * Get financial summary (Trial Balance logic)
   */
  async getFinancialSummary(dto: FinancialSummaryDto) {
    const { fromDate, toDate, includeOpBal, hideZeroClosing, hideZeroTrans } = dto;

    try {
      // Build the raw SQL query with conditional aggregation
      const query = `
        SELECT 
          h.code as head_code,
          h.head_name,
          h.headtype,
          
          -- 1. Calculate Opening Balance (Everything BEFORE fromDate)
          COALESCE(SUM(CASE 
            WHEN $3::boolean = true AND l.trans_date < $1::date
            THEN (
              CASE 
                WHEN l.trans_type = 'CR' THEN l.trans_amt::numeric
                WHEN l.trans_type = 'DR' THEN -l.trans_amt::numeric
                ELSE 0
              END
            )
            ELSE 0 
          END), 0) AS opening_balance,

          -- 2. Calculate Period Activity (Between Dates)
          COALESCE(SUM(CASE 
            WHEN l.trans_date >= $1::date AND l.trans_date <= $2::date AND l.trans_type = 'DR'
            THEN l.trans_amt::numeric
            ELSE 0 
          END), 0) AS period_debit,
          
          COALESCE(SUM(CASE 
            WHEN l.trans_date >= $1::date AND l.trans_date <= $2::date AND l.trans_type = 'CR'
            THEN l.trans_amt::numeric
            ELSE 0 
          END), 0) AS period_credit,

          -- 3. Calculate Total Closing Balance (All transactions up to toDate)
          COALESCE(SUM(CASE
            WHEN l.trans_date <= $2::date
            THEN (
              CASE 
                WHEN l.trans_type = 'CR' THEN l.trans_amt::numeric
                WHEN l.trans_type = 'DR' THEN -l.trans_amt::numeric
                ELSE 0
              END
            )
            ELSE 0
          END), 0) AS closing_balance

        FROM 
          headmaster h
        LEFT JOIN 
          ledger l ON h.code = l.code
        GROUP BY 
          h.code, h.head_name, h.headtype
        ORDER BY 
          h.code
      `;

      const rawResults = await this.dataSource.query(query, [
        parseSafeDate(fromDate),
        parseSafeDate(toDate),
        includeOpBal
      ]);

      // Filter results based on suppression options
      let filteredResults = rawResults;

      if (hideZeroClosing) {
        filteredResults = filteredResults.filter((row: any) =>
          Math.abs(parseFloat(row.closing_balance || '0')) > 0.01
        );
      }

      if (hideZeroTrans) {
        filteredResults = filteredResults.filter((row: any) => {
          const periodActivity = parseFloat(row.period_debit || '0') + parseFloat(row.period_credit || '0');
          return periodActivity > 0.01;
        });
      }

      // Format the results
      return filteredResults.map((row: any, index: number) => ({
        key: index.toString(),
        headCode: row.head_code,
        headName: row.head_name,
        headType: row.headtype,
        openingBalance: parseFloat(row.opening_balance || '0'),
        periodDebit: parseFloat(row.period_debit || '0'),
        periodCredit: parseFloat(row.period_credit || '0'),
        closingBalance: parseFloat(row.closing_balance || '0')
      }));
    } catch (error) {
      this.logger.error('Error in getFinancialSummary:', error);
      throw error;
    }
  }

  /**
   * Get account closing register
   */
  async getAccountClosingRegister(dto: { month: number; year: number; accountType?: string }) {
    const { month, year, accountType } = dto;
    const fromDate = parseSafeDate(`${year}-${month.toString().padStart(2, '0')}-01`);
    const dateObj = new Date(year, month, 0);
    const toDate = parseSafeDate(`${year}-${month.toString().padStart(2, '0')}-${dateObj.getDate()}`);

    // Collect from multiple tables since account_closing_register doesn't exist
    let results: any[] = [];

    if (!accountType || accountType === 'FD' || accountType === 'ALL') {
      const fdClosures = await this.dataSource.query(`
        SELECT 
          fd."accountNumber" as account_no,
          fd."memberId" as member_no,
          TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
          'FD' as account_type,
          fd."closureDate" as closing_date,
          CAST(fd."closureAmount" AS numeric) as final_amount,
          fd."closureReason" as description
        FROM fixed_deposits fd
        LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(fd."memberId" AS text)
        WHERE fd."closureDate" IS NOT NULL
          AND fd."closureDate" >= $1 AND fd."closureDate" <= $2
      `, [fromDate, toDate]);
      results = results.concat(fdClosures);
    }

    if (!accountType || accountType === 'RD' || accountType === 'ALL') {
      const rdClosures = await this.dataSource.query(`
        SELECT 
          rd."accountNumber" as account_no,
          rd."memberId" as member_no,
          TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
          'RD' as account_type,
          rd."closureDate" as closing_date,
          CAST(rd."closureAmount" AS numeric) as final_amount,
          rd."closureReason" as description
        FROM recurring_deposits rd
        LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(rd."memberId" AS text)
        WHERE rd."closureDate" IS NOT NULL
          AND rd."closureDate" >= $1 AND rd."closureDate" <= $2
      `, [fromDate, toDate]);
      results = results.concat(rdClosures);
    }

    return results.map((r: any, idx: number) => ({
      key: idx.toString(),
      memberCode: r.member_no,
      memberName: r.member_name,
      accountNo: r.account_no,
      accountType: r.account_type,
      closingDate: r.closing_date,
      finalAmount: parseFloat(r.final_amount) || 0,
      description: r.description || 'Account Closed'
    }));
  }

  /**
   * Get recovery details
   */
  async getRecoveryDetails(dto: { memberNo: string; month: string; year: number; wingNo?: string }) {
    const { memberNo, month, year } = dto;

    const monthMap: Record<string, number> = {
      JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3,
      APR: 4, APRIL: 4, MAY: 5, JUN: 6, JUNE: 6,
      JUL: 7, JULY: 7, AUG: 8, AUGUST: 8, SEP: 9, SEPTEMBER: 9,
      OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11, DEC: 12, DECEMBER: 12,
    };
    const monthNum = monthMap[(month || '').toUpperCase()] || parseInt(month) || 0;

    const query = `
      SELECT
        d.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        m.present_address as address,
        d.demand_for_month,
        d.demand_for_year,
        COALESCE(d.totaldemand, 0) as total_demand,
        COALESCE(d.rln_installment_amount, 0) as rln_amt,
        COALESCE(d.eln_installment_amount, 0) as eln_amt,
        COALESCE(d.aln_installment_amount, 0) as aln_amt,
        COALESCE(d.rdbalance, 0) as rd_amt,
        COALESCE(d.mdbalance, 0) as md_amt,
        COALESCE(d.cdbalance, 0) as cd_amt,
        COALESCE(d.shr_amount, 0) as sd_amt,
        COALESCE(d.bankcharge, 0) as bank_charges,
        COALESCE(d."OTHERS", 0) as other_charges,
        d.demand_posted
      FROM demand_master d
      LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(d.mbno AS text)
      WHERE CAST(d.mbno AS text) = $1
        AND d.demand_for_month = $2
        AND d.demand_for_year = $3
    `;

    const results = await this.dataSource.query(query, [memberNo, monthNum, year]);

    if (results.length === 0) {
      return null;
    }

    const monthNames = ['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const r = results[0];
    return {
      memberNo: r.member_no,
      memberName: r.member_name,
      address: r.address || 'Address not available',
      demandMonth: r.demand_for_month,
      demandYear: r.demand_for_year,
      period: `${monthNames[r.demand_for_month] || r.demand_for_month} ${r.demand_for_year}`,
      totalDemand: parseFloat(r.total_demand) || 0,
      loanRecoveries: {
        regularLoan: parseFloat(r.rln_amt) || 0,
        emergencyLoan: parseFloat(r.eln_amt) || 0,
        advanceLoan: parseFloat(r.aln_amt) || 0,
        miscLoan: 0
      },
      depositRecoveries: {
        recurringDeposit: parseFloat(r.rd_amt) || 0,
        monthlyDeposit: parseFloat(r.md_amt) || 0,
        compulsoryDeposit: parseFloat(r.cd_amt) || 0,
        shareAmount: parseFloat(r.sd_amt) || 0
      },
      charges: {
        bankCharges: parseFloat(r.bank_charges) || 0,
        otherCharges: parseFloat(r.other_charges) || 0
      },
      balanceForMonth: 0,
      demandGeneratedDate: null,
      demandPostedDate: r.demand_posted ? 'Posted' : null,
      status: r.demand_posted ? 'Posted' : 'Generated'
    };
  }

  /**
   * Diagnostic check
   */
  async diagnosticCheck() {
    try {
      const memberCount = await this.dataSource.query(`SELECT COUNT(*)::text as count FROM member_master`);
      const loanCount = await this.dataSource.query(`SELECT COUNT(*)::text as count FROM loan_master`);
      const depositCount = await this.dataSource.query(`SELECT (SELECT COUNT(*) FROM fixed_deposits) + (SELECT COUNT(*) FROM recurring_deposits) as count`);

      return {
        status: 'OK',
        members: memberCount[0]?.count || '0',
        loans: loanCount[0]?.count || '0',
        deposits: depositCount[0]?.count || '0'
      };
    } catch (error) {
      return {
        status: 'ERROR',
        message: error.message
      };
    }
  }

  /**
   * Get AdHoc Reports
   */
  async getAdHocReports(dto: {
    reportType: string;
    fromDate?: string;
    toDate?: string;
    memberNo?: string;
    accountType?: string;
    customQuery?: string;
  }) {
    const { reportType, fromDate, toDate, memberNo, accountType, customQuery } = dto;

    let query = '';
    let params: any[] = [];

    switch (reportType) {
      case 'member_wise':
        query = `
          SELECT 
            m.mbno as "memberNo",
            TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as "memberName",
            m.present_address as "address",
            m.desig as "designation",
            d.name as "officeName",
            m.memb_date as "membershipDate",
            m.isactive as "status"
          FROM member_master m
          LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
          WHERE 1=1
        `;
        if (memberNo) {
          query += ' AND CAST(m.mbno AS text) = $1';
          params.push(memberNo);
        }
        query += ' ORDER BY m.mbno LIMIT 500';
        break;

      case 'account_wise':
        query = `
          SELECT * FROM (
            SELECT 
              fd.accountNumber as "accountNo",
              fd.memberId as "memberNo",
              'Fixed Deposit' as "type",
              CAST(fd.principalAmount AS numeric) as "amount",
              fd.depositDate as "date",
              fd.status
            FROM fixed_deposits fd
            UNION ALL
            SELECT 
              rd.accountNumber as "accountNo",
              rd.memberId as "memberNo",
              'Recurring Deposit' as "type",
              CAST(rd.totalDeposited AS numeric) as "amount",
              rd.startDate as "date",
              rd.status
            FROM recurring_deposits rd
          ) accounts
          WHERE 1=1
        `;
        if (fromDate && toDate) {
          query += ' AND "date" >= $1 AND "date" <= $2';
          params.push(parseSafeDate(fromDate), parseSafeDate(toDate));
        }
        if (memberNo) {
          query += ` AND "memberNo" = $${params.length + 1}`;
          params.push(memberNo);
        }
        query += ' ORDER BY "date" DESC LIMIT 500';
        break;

      case 'transaction_wise':
        query = `
          SELECT 
            l.trans_date as "date",
            l.mbno as "memberNo",
            TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as "memberName",
            l.trans_type as "type",
            CAST(l.trans_amt AS numeric) as "amount",
            l.narration,
            l.receipt_vchr_no as "voucherNo"
          FROM ledger l
          LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(l.mbno AS text)
          WHERE 1=1
        `;
        if (fromDate && toDate) {
          query += ' AND l.trans_date >= $1 AND l.trans_date <= $2';
          params.push(parseSafeDate(fromDate), parseSafeDate(toDate));
        }
        if (memberNo) {
          query += ` AND CAST(l.mbno AS text) = $${params.length + 1}`;
          params.push(memberNo);
        }
        query += ' ORDER BY l.trans_date DESC LIMIT 1000';
        break;

      case 'balance_summary':
        query = `
          SELECT 
            'Fixed Deposits' as "category",
            COUNT(*) as "count",
            SUM(CAST(principalAmount AS numeric)) as "totalAmount"
          FROM fixed_deposits
          GROUP BY 1
          UNION ALL
          SELECT 
            'Recurring Deposits' as "category",
            COUNT(*) as "count",
            SUM(CAST(totalDeposited AS numeric)) as "totalAmount"
          FROM recurring_deposits
          GROUP BY 1
          UNION ALL
          SELECT 
            'Loans' as "category",
            COUNT(*) as "count",
            SUM(CAST(balance AS numeric)) as "totalAmount"
          FROM loan_master
          GROUP BY 1
        `;
        break;

      case 'custom':
        if (!customQuery) throw new Error('Custom query is required');
        const upper = customQuery.trim().toUpperCase();
        if (!upper.startsWith('SELECT')) throw new Error('Only SELECT queries allowed');
        const forbidden = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'CREATE', 'TRUNCATE'];
        if (forbidden.some(word => upper.includes(word))) throw new Error('Restricted operation detected');
        query = customQuery;
        break;

      default:
        // 5.1 fix: was reaching callers as 500 instead of 400.
        throw new BadRequestException('Unsupported report type');
    }

    const results = await this.dataSource.query(query, params);

    return {
      reportType,
      totalRecords: results.length,
      data: results,
      generatedAt: new Date().toISOString()
    };
  }
}
