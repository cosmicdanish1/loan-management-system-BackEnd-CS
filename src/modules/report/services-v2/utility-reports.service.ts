import { Injectable } from '@nestjs/common';
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
      console.error('Error in getFinancialSummary:', error);
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

    // Closed FD/RD accounts live in fdmaster (status 'C', closing date in statusdate);
    // there is no account_closing_register table and recurring_deposits is an unused demo table.
    let results: any[] = [];

    if (!accountType || accountType === 'FD' || accountType === 'RD' || accountType === 'ALL') {
      const flag = accountType === 'FD' ? 'F' : accountType === 'RD' ? 'R' : null;
      const params: any[] = [fromDate, toDate];
      let flagClause = '';
      if (flag) {
        params.push(flag);
        flagClause = ` AND f.fdrdflag = $3`;
      }
      results = await this.dataSource.query(`
        SELECT
          f.account_number as account_no,
          f.mbno as member_no,
          COALESCE(NULLIF(TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')), ''), TRIM(COALESCE(f.f_name, '') || ' ' || COALESCE(f.l_name, ''))) as member_name,
          CASE WHEN f.fdrdflag = 'R' THEN 'RD' ELSE 'FD' END as account_type,
          f.statusdate as closing_date,
          CAST(f.matamount AS numeric) as final_amount,
          f.remarks as description
        FROM fdmaster f
        LEFT JOIN member_master m ON m.mbno = f.mbno
        WHERE f.status = 'C'
          AND f.statusdate IS NOT NULL
          AND f.statusdate >= $1 AND f.statusdate < ($2::date + INTERVAL '1 day')${flagClause}
        ORDER BY f.statusdate ASC, f.account_number ASC
      `, params);
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

    // demand_master keeps the month as a number (1-12); the screen sends the
    // three-letter name (JAN..DEC). Accept either.
    const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const monthText = String(month ?? '').trim();
    const monthNo = /^\d{1,2}$/.test(monthText)
      ? Number(monthText)
      : MONTH_NAMES.indexOf(monthText.slice(0, 3).toUpperCase()) + 1;
    if (!monthNo || monthNo < 1 || monthNo > 12) {
      throw new Error(`Invalid month '${month}'`);
    }

    // Column names are the real demand_master ones: totaldemand, bankcharge and
    // "OTHERS" (upper case, so it must be quoted), shr_amount for the share part.
    // The deposit parts are what is demanded this month (rd/md/cd_amount), not the
    // running balances; MD also has five extra slots (md1..md5). Each loan part is
    // the installment plus its interest.
    const query = `
      SELECT
        d.mbno AS member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) AS member_name,
        m.present_address AS address,
        d.demand_for_month,
        d.demand_for_year,
        COALESCE(d.totaldemand, 0) AS total_demand,
        COALESCE(d.rln_installment_amount, 0) + COALESCE(d.rln_interest, 0) AS rln_amt,
        COALESCE(d.eln_installment_amount, 0) + COALESCE(d.eln_interest, 0) AS eln_amt,
        COALESCE(d.aln_installment_amount, 0) + COALESCE(d.aln_interest, 0) AS aln_amt,
        COALESCE(d.mln_installment_amount, 0) + COALESCE(d.mln_interest, 0) AS mln_amt,
        COALESCE(d.rln_amount, 0) AS rln_out,
        COALESCE(d.eln_amount, 0) AS eln_out,
        COALESCE(d.aln_amount, 0) AS aln_out,
        COALESCE(d.rln_installment_amount, 0) AS rln_prin,
        COALESCE(d.eln_installment_amount, 0) AS eln_prin,
        COALESCE(d.aln_installment_amount, 0) AS aln_prin,
        COALESCE(d.mln_installment_amount, 0) AS mln_prin,
        COALESCE(d.rln_interest, 0) AS rln_int,
        COALESCE(d.eln_interest, 0) AS eln_int,
        COALESCE(d.aln_interest, 0) AS aln_int,
        COALESCE(d.mln_interest, 0) AS mln_int,
        COALESCE(d.rdbalance, 0) AS rd_bal,
        COALESCE(d.rd_amount, 0) AS rd_amt,
        COALESCE(d.md_amount, 0) + COALESCE(d.md1_amount, 0) + COALESCE(d.md2_amount, 0)
          + COALESCE(d.md3_amount, 0) + COALESCE(d.md4_amount, 0) + COALESCE(d.md5_amount, 0) AS md_amt,
        COALESCE(d.cd_amount, 0) AS cd_amt,
        COALESCE(d.shr_amount, 0) AS shr_amt,
        COALESCE(d.bankcharge, 0) AS bank_charges,
        COALESCE(d."OTHERS", 0) AS other_charges,
        d.demand_posted
      FROM demand_master d
      LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(d.mbno AS text)
      WHERE CAST(d.mbno AS text) = $1
        AND d.demand_for_month = $2
        AND d.demand_for_year = $3
      ORDER BY d.dmnd_srno DESC NULLS LAST
      LIMIT 1
    `;

    const results = await this.dataSource.query(query, [memberNo, monthNo, Number(year)]);

    if (results.length === 0) {
      throw new Error('No recovery details found for the selected member and period');
    }

    const r = results[0];
    const posted = String(r.demand_posted ?? '').toUpperCase() === 'Y';
    const monthLabel = MONTH_NAMES[monthNo - 1];
    return {
      memberNo: r.member_no,
      memberName: r.member_name,
      address: r.address || 'Address not available',
      demandMonth: monthLabel,
      demandYear: r.demand_for_year,
      period: `${monthLabel} ${r.demand_for_year}`,
      totalDemand: parseFloat(r.total_demand) || 0,
      loanRecoveries: {
        regularLoan: parseFloat(r.rln_amt) || 0,
        emergencyLoan: parseFloat(r.eln_amt) || 0,
        advanceLoan: parseFloat(r.aln_amt) || 0,
        miscLoan: parseFloat(r.mln_amt) || 0
      },
      depositRecoveries: {
        recurringDeposit: parseFloat(r.rd_amt) || 0,
        monthlyDeposit: parseFloat(r.md_amt) || 0,
        compulsoryDeposit: parseFloat(r.cd_amt) || 0,
        shareAmount: parseFloat(r.shr_amt) || 0
      },
      charges: {
        bankCharges: parseFloat(r.bank_charges) || 0,
        otherCharges: parseFloat(r.other_charges) || 0
      },
      // The parts behind the loan recoveries above, for the legacy table: what is still
      // outstanding on each loan, the principal and the interest recovered this month, and the RD balance.
      // Same names as loanRecoveries: emergencyLoan = Loan Against RD (ELN), advanceLoan = Emergency Loan (ALN).
      loanOutstanding: {
        regularLoan: parseFloat(r.rln_out) || 0,
        emergencyLoan: parseFloat(r.eln_out) || 0,
        advanceLoan: parseFloat(r.aln_out) || 0
      },
      loanPrincipal: {
        regularLoan: parseFloat(r.rln_prin) || 0,
        emergencyLoan: parseFloat(r.eln_prin) || 0,
        advanceLoan: parseFloat(r.aln_prin) || 0,
        miscLoan: parseFloat(r.mln_prin) || 0
      },
      loanInterest: {
        regularLoan: parseFloat(r.rln_int) || 0,
        emergencyLoan: parseFloat(r.eln_int) || 0,
        advanceLoan: parseFloat(r.aln_int) || 0,
        miscLoan: parseFloat(r.mln_int) || 0
      },
      rdBalance: parseFloat(r.rd_bal) || 0,
      balanceForMonth: 0,
      demandGeneratedDate: null,
      demandPostedDate: posted ? 'Posted' : null,
      status: posted ? 'Posted' : 'Generated'
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
        throw new Error('Unsupported report type');
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
