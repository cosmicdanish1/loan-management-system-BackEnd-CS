import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { parseSafeDate } from '../../shared/utils/date-utils';

/**
 * Loan Reports Service - Handles loan-focused reports.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from report.service.ts for single responsibility
 */
@Injectable()
export class LoanReportsService {
  constructor(private readonly dataSource: DataSource) { }

  /**
   * Get defaulter list
   */
  async getDefaulterList(dto: { minBalance?: number; loanType?: string; limit?: number; offset?: number }) {
    const minBalance = dto.minBalance || 0;
    const { limit, offset } = dto;

    const baseQuery = `
      FROM loan_master loan
      LEFT JOIN member_master member ON member.mbno = loan.mbno
      LEFT JOIN division_master d ON member.officeno = d.officeno AND member.wingno = d.wingno
      WHERE CAST(loan.balance AS numeric) > $1
    `;

    const params: any[] = [minBalance];
    let whereClause = '';

    if (dto.loanType) {
      whereClause += ` AND loan.loantype = $${params.length + 1}`;
      params.push(dto.loanType);
    }

    // Get total count
    const totalCountRes = await this.dataSource.query(`SELECT COUNT(*) ${baseQuery} ${whereClause}`, params);
    const totalCount = parseInt(totalCountRes[0].count);

    let query = `
      SELECT 
        loan.mbno as member_no,
        member.f_name || ' ' || COALESCE(member.l_name, '') as member_name,
        d.name as office_name,
        loan.loantype as loan_type,
        loan.loancaseno as loan_case_no,
        CAST(loan.loan_amt AS numeric) as loan_amount,
        CAST(loan.balance AS numeric) as balance,
        loan.no_of_instal as installments,
        loan.payment_date as last_payment_date
      ${baseQuery} ${whereClause}
      ORDER BY CAST(loan.balance AS numeric) DESC
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
      data: result.map((d: any, idx: number) => ({
        key: ((offset || 0) + idx).toString(),
        memberNo: d.member_no,
        memberName: d.member_name?.trim() || '',
        officeName: d.office_name,
        loanType: d.loan_type,
        loanCaseNo: d.loan_case_no,
        loanAmount: parseFloat(d.loan_amount) || 0,
        balance: parseFloat(d.balance) || 0,
        installments: d.installments,
        lastPaymentDate: d.last_payment_date
      }))
    };
  }

  /**
   * Get newly disbursed loans
   */
  async getNewLoanDisbursed(dto: { fromDate: string; toDate: string; loanType?: string; limit?: number; offset?: number }) {
    const { fromDate, toDate, loanType, limit, offset } = dto;

    const baseQuery = `
      FROM loan_master loan
      LEFT JOIN member_master m ON m.mbno = loan.mbno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE loan.payment_date >= $1 AND loan.payment_date <= $2
    `;

    const params: any[] = [parseSafeDate(fromDate), parseSafeDate(toDate)];
    let whereClause = '';

    if (loanType) {
      whereClause += ` AND loan.loantype = $${params.length + 1}`;
      params.push(loanType);
    }

    // Get total count
    const totalCountRes = await this.dataSource.query(`SELECT COUNT(*) ${baseQuery} ${whereClause}`, params);
    const totalCount = parseInt(totalCountRes[0].count);

    let query = `
      SELECT 
        loan.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        loan.loantype as loan_type,
        loan.loancaseno as loan_case_no,
        CAST(loan.loan_amt AS numeric) as loan_amount,
        loan.payment_date as disbursement_date,
        loan.no_of_instal as installments,
        loan.rate as interest_rate
      ${baseQuery} ${whereClause}
      ORDER BY loan.payment_date DESC
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
      data: result.map((l: any, idx: number) => ({
        key: ((offset || 0) + idx).toString(),
        memberNo: l.member_no,
        memberName: l.member_name,
        officeName: l.office_name,
        loanType: l.loan_type,
        loanCaseNo: l.loan_case_no,
        loanAmount: parseFloat(l.loan_amount) || 0,
        disbursementDate: l.disbursement_date,
        installments: l.installments,
        interestRate: l.interest_rate
      }))
    };
  }

  /**
   * Get member loan ledger
   */
  async getMemberLoanLedger(dto: { memberNo: string; loanCaseNo?: string; fromDate?: string; toDate?: string; limit?: number; offset?: number }) {
    const { memberNo, loanCaseNo, fromDate, toDate, limit, offset } = dto;

    // Get member info
    const memberQuery = `
      SELECT 
        TRIM(COALESCE(f_name, '') || ' ' || COALESCE(l_name, '')) as member_name
      FROM member_master WHERE mbno = $1
    `;
    const memberResult = await this.dataSource.query(memberQuery, [memberNo]);
    const memberName = memberResult[0]?.member_name || 'Unknown';

    // Base criteria for loan transactions
    const criteria = `WHERE mbno = $1 AND (code LIKE 'A10%' OR acc_type IN ('RLN', 'ELN', 'ALN'))`;
    const params: any[] = [memberNo];
    let filterClause = '';

    if (loanCaseNo) {
      filterClause += ` AND acc_no = $${params.length + 1}`;
      params.push(loanCaseNo);
    }

    if (fromDate) {
      filterClause += ` AND trans_date >= $${params.length + 1}`;
      params.push(fromDate);
    }

    if (toDate) {
      filterClause += ` AND trans_date <= $${params.length + 1}`;
      params.push(toDate);
    }

    // Get total count
    const totalCountRes = await this.dataSource.query(`SELECT COUNT(*) FROM ledger ${criteria} ${filterClause}`, params);
    const totalCount = parseInt(totalCountRes[0].count);

    // Get loan transactions
    let query = `
      SELECT 
        trans_date as date,
        trans_type as type,
        trans_amt as amount,
        narration,
        receipt_vchr_no as voucher_no
      FROM ledger
      ${criteria} ${filterClause}
      ORDER BY trans_date ASC, trans_no ASC
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

    const transactions = await this.dataSource.query(query, queryParams);

    let runningBalance = 0;
    const ledgerData = transactions.map((t: any, idx: number) => {
      const amount = parseFloat(t.amount) || 0;
      const isDebit = t.type === 'DR' || t.type === 'D';

      if (isDebit) {
        runningBalance += amount;
      } else {
        runningBalance -= amount;
      }

      return {
        key: ((offset || 0) + idx).toString(),
        date: t.date,
        type: t.type,
        amount: amount,
        narration: t.narration,
        voucherNo: t.voucher_no,
        balance: runningBalance
      };
    });

    return {
      metadata: {
        totalCount,
        limit: limit || totalCount,
        offset: offset || 0
      },
      memberNo,
      memberName,
      loanCaseNo: loanCaseNo || 'All',
      transactions: ledgerData
    };
  }

  /**
   * Get member loan detail
   */
  async getMemberLoanDetail(dto: { memberFrom?: string; memberTo?: string; loanType?: string; limit?: number; offset?: number }) {
    const { limit, offset } = dto;

    const baseQuery = `
      FROM loan_master loan
      LEFT JOIN member_master m ON m.mbno = loan.mbno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE 1=1
    `;

    const params: any[] = [];
    let whereClause = '';

    if (dto.memberFrom) {
      whereClause += ` AND loan.mbno::numeric >= $${params.length + 1}`;
      params.push(dto.memberFrom);
    }

    if (dto.memberTo) {
      whereClause += ` AND loan.mbno::numeric <= $${params.length + 1}`;
      params.push(dto.memberTo);
    }

    if (dto.loanType && dto.loanType !== 'ALL') {
      whereClause += ` AND loan.loantype = $${params.length + 1}`;
      params.push(dto.loanType);
    }

    // Get total count
    const totalCountRes = await this.dataSource.query(`SELECT COUNT(*) ${baseQuery} ${whereClause}`, params);
    const totalCount = parseInt(totalCountRes[0].count);

    let query = `
      SELECT 
        loan.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        loan.loantype as loan_type,
        loan.loancaseno as loan_case_no,
        CAST(loan.loan_amt AS numeric) as loan_amount,
        CAST(loan.balance AS numeric) as balance,
        loan.rate as interest_rate,
        loan.no_of_instal as total_installments,
        loan.instal_amt as installment_amount,
        loan.payment_date as disbursement_date
      ${baseQuery} ${whereClause}
      ORDER BY loan.mbno::numeric, loan.loancaseno
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

    // Fetch Society Details
    const societyDetails = await this.dataSource.query('SELECT * FROM society_details LIMIT 1');
    const society = societyDetails[0] || {};

    return {
      metadata: {
        totalCount,
        limit: limit || totalCount,
        offset: offset || 0
      },
      data: result.map((l: any, idx: number) => ({
        key: ((offset || 0) + idx).toString(),
        memberNo: l.member_no,
        memberName: l.member_name,
        officeName: l.office_name,
        loanType: l.loan_type,
        loanCaseNo: l.loan_case_no,
        loanAmount: parseFloat(l.loan_amount) || 0,
        balance: parseFloat(l.balance) || 0,
        interestRate: l.interest_rate,
        totalInstallments: l.total_installments,
        installmentAmount: parseFloat(l.installment_amount) || 0,
        disbursementDate: l.disbursement_date
      })),
      societyName: society.name || 'EMP ESPAT EMPLOYEES CO-OP CREDIT SOCIETY LTD.',
      societyAddress: society.address || 'Sector 27A, Nigdi, Pradhikaran, Pune - 411044',
    };
  }

  /**
   * Get surety register
   */
  async getSuretyRegister(dto: { memberFrom?: string; memberTo?: string; memberNo?: string; loanType?: string; limit?: number; offset?: number }) {
    const { limit, offset, memberFrom, memberTo, memberNo, loanType } = dto;

    const baseQuery = `
      FROM loan_pending lp
      LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(lp.mbno AS text)
      LEFT JOIN member_master s1 ON CAST(s1.mbno AS text) = CAST(lp.g1mbno AS text)
      LEFT JOIN member_master s2 ON CAST(s2.mbno AS text) = CAST(lp.g2mbno AS text)
      LEFT JOIN loan_master lm ON lp.loancaseno = lm.loancaseno
      WHERE 1=1
    `;

    const params: any[] = [];
    let whereClause = '';

    // Handle member range filter
    if (memberFrom && memberTo) {
      whereClause += ` AND CAST(lp.mbno AS integer) BETWEEN $${params.length + 1} AND $${params.length + 2}`;
      params.push(parseInt(memberFrom), parseInt(memberTo));
    } else if (memberNo) {
      whereClause += ` AND (CAST(lp.mbno AS text) = $${params.length + 1} OR CAST(lp.g1mbno AS text) = $${params.length + 1} OR CAST(lp.g2mbno AS text) = $${params.length + 1})`;
      params.push(memberNo);
    }

    // Handle loan type filter
    if (loanType) {
      whereClause += ` AND lp.loantype = $${params.length + 1}`;
      params.push(loanType);
    }

    // Get total count
    const totalCountRes = await this.dataSource.query(`SELECT COUNT(*) ${baseQuery} ${whereClause}`, params);
    const totalCount = parseInt(totalCountRes[0].count);

    let query = `
      SELECT 
        lp.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        lp.loancaseno as loan_no,
        lp.loantype as loan_type,
        CAST(lp.sanctioned_amt AS numeric) as loan_amount,
        lp.g1mbno as surety_mbno,
        TRIM(COALESCE(s1.f_name, '') || ' ' || COALESCE(s1.l_name, '')) as surety_name,
        CAST(COALESCE(lm.balance, 0) AS numeric) as outstanding_balance
      ${baseQuery} ${whereClause}
      ORDER BY lp.loancaseno DESC
    `;

    const queryParams = [...params];
    const finalLimit = limit || 500;
    query += ` LIMIT $${queryParams.length + 1}`;
    queryParams.push(finalLimit);

    if (offset !== undefined) {
      query += ` OFFSET $${queryParams.length + 1}`;
      queryParams.push(offset);
    }

    const result = await this.dataSource.query(query, queryParams);

    // Transform data to match frontend expectations
    return result.map((r: any, idx: number) => ({
      key: ((offset || 0) + idx).toString(),
      mbno: r.member_no,
      memberName: r.member_name,
      loanNo: r.loan_no,
      loanType: r.loan_type,
      loanAmount: parseFloat(r.loan_amount) || 0,
      suretyMbno: r.surety_mbno,
      suretyName: r.surety_name,
      outstandingBalance: parseFloat(r.outstanding_balance) || 0
    }));
  }

  /**
   * Get loan types list
   */
  async getLoanTypes() {
    const result = await this.dataSource.query(`
      SELECT DISTINCT loantype as code, 
        CASE 
          WHEN loantype = 'RLN' THEN 'Regular Loan'
          WHEN loantype = 'ELN' THEN 'Emergency Loan'
          WHEN loantype = 'ALN' THEN 'Against Deposit Loan'
          ELSE loantype
        END as name
      FROM loan_master
      WHERE loantype IS NOT NULL
      ORDER BY loantype
    `);

    return result;
  }

  /**
   * Get Interest Receivable/Received Statement
   */
  async getInterestStatement(dto: { fromMonth?: number; fromYear?: number; toMonth?: number; toYear?: number; branch?: string; fromMember?: string; toMember?: string }) {
    const { fromMonth = 1, fromYear = 2020, toMonth = 12, toYear = 2025 } = dto;

    let receivableQuery = `
      SELECT 
        demand_for_month as month,
        demand_for_year as year,
        SUM(COALESCE(rln_interest, 0) + COALESCE(eln_interest, 0) + COALESCE(aln_interest, 0) + 
            COALESCE(mln_interest, 0) + COALESCE(fln_interest, 0) + COALESCE(edl_interest, 0)) as receivable
      FROM demand_master
      WHERE (demand_for_year > $1 OR (demand_for_year = $1 AND demand_for_month >= $2))
        AND (demand_for_year < $3 OR (demand_for_year = $3 AND demand_for_month <= $4))
    `;

    const receivableParams: any[] = [fromYear, fromMonth, toYear, toMonth];

    if (dto.fromMember) {
      receivableQuery += ` AND mbno >= $${receivableParams.length + 1}`;
      receivableParams.push(dto.fromMember);
    }
    if (dto.toMember) {
      receivableQuery += ` AND mbno <= $${receivableParams.length + 1}`;
      receivableParams.push(dto.toMember);
    }
    if (dto.branch) {
      receivableQuery += ` AND officeno = $${receivableParams.length + 1}`;
      receivableParams.push(dto.branch);
    }

    receivableQuery += ` GROUP BY demand_for_year, demand_for_month ORDER BY demand_for_year, demand_for_month`;

    const receivables = await this.dataSource.query(receivableQuery, receivableParams);

    let receivedQuery = `
      SELECT 
        EXTRACT(MONTH FROM trans_date) as month,
        EXTRACT(YEAR FROM trans_date) as year,
        SUM(CASE WHEN trans_type = 'CR' THEN COALESCE(trans_amt, 0) ELSE -COALESCE(trans_amt, 0) END) as received
      FROM ledger
      WHERE code IN ('I1002', 'I1008')
        AND trans_date >= $1 AND trans_date <= $2
    `;

    const startDate = `${fromYear}-${fromMonth.toString().padStart(2, '0')}-01`;
    const endDate = `${toYear}-${toMonth.toString().padStart(2, '0')}-31`;
    const receivedParams: any[] = [startDate, endDate];

    if (dto.fromMember) {
      receivedQuery += ` AND mbno >= $${receivedParams.length + 1}`;
      receivedParams.push(dto.fromMember);
    }
    if (dto.toMember) {
      receivedQuery += ` AND mbno <= $${receivedParams.length + 1}`;
      receivedParams.push(dto.toMember);
    }

    receivedQuery += ` GROUP BY EXTRACT(YEAR FROM trans_date), EXTRACT(MONTH FROM trans_date)
                       ORDER BY EXTRACT(YEAR FROM trans_date), EXTRACT(MONTH FROM trans_date)`;

    const receivedData = await this.dataSource.query(receivedQuery, receivedParams);

    const resultsMap = new Map();
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

    receivables.forEach((r: any) => {
      const key = `${r.year}-${r.month}`;
      resultsMap.set(key, {
        month: r.month,
        year: r.year,
        demandForMonth: `${monthNames[r.month - 1]} ${r.year}`,
        interestReceived: 0,
        interestReceivable: parseFloat(r.receivable) || 0,
      });
    });

    receivedData.forEach((rec: any) => {
      const key = `${rec.year}-${rec.month}`;
      if (resultsMap.has(key)) {
        const entry = resultsMap.get(key);
        entry.interestReceived = parseFloat(rec.received) || 0;
      } else {
        resultsMap.set(key, {
          month: rec.month,
          year: rec.year,
          demandForMonth: `${monthNames[rec.month - 1]} ${rec.year}`,
          interestReceived: parseFloat(rec.received) || 0,
          interestReceivable: 0,
        });
      }
    });

    return Array.from(resultsMap.values())
      .map((item, idx) => ({
        key: idx.toString(),
        ...item,
        amount: item.interestReceivable + item.interestReceived
      }))
      .sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month));
  }
  /**
   * Get Loan Nil Certificate (NOC)
   */
  async getLoanNilCertificate(memberNo: string) {
    // Check for active loans (balance > 0)
    const activeLoans = await this.dataSource.query(`
      SELECT 
        loantype as head_name,
        loancaseno as head_code,
        CAST(balance AS numeric) as balance
      FROM loan_master 
      WHERE mbno = $1 AND CAST(balance AS numeric) > 0
    `, [memberNo]);

    // Get member info
    const memberRes = await this.dataSource.query(`
      SELECT TRIM(COALESCE(f_name, '') || ' ' || COALESCE(l_name, '')) as member_name, doj
      FROM member_master WHERE mbno = $1
    `, [memberNo]);

    const member = memberRes[0] || { member_name: `Member ${memberNo}`, doj: null };

    return {
      success: true,
      data: {
        memberNo,
        memberName: member.member_name,
        joiningDate: member.doj,
        isNil: activeLoans.length === 0,
        outstandingLoans: activeLoans.map((l: any) => ({
          headName: l.head_name === 'RLN' ? 'Regular Loan' :
            l.head_name === 'ELN' ? 'Emergency Loan' :
              l.head_name === 'ALN' ? 'Against Deposit Loan' : l.head_name,
          headCode: l.head_code,
          balance: parseFloat(l.balance) || 0
        }))
      }
    };
  }

  /**
   * Get loan contributions register
   * Shows loan details and related transactions for a member
   */
  async getLoanContributionsRegister(dto: { memberNo: string; fromDate: string; toDate: string }) {
    const { memberNo, fromDate, toDate } = dto;

    // 1. Get Member Info
    const memberRes = await this.dataSource.query(`
      SELECT 
        mbno, 
        TRIM(COALESCE(f_name, '') || ' ' || COALESCE(l_name, '')) as name,
        present_address as address
      FROM member_master 
      WHERE CAST(mbno AS text) = $1
    `, [memberNo]);

    if (memberRes.length === 0) {
      throw new Error('Member not found');
    }

    const member = memberRes[0];

    // 2. Get Loans for this member
    const loans = await this.dataSource.query(`
      SELECT 
        loancaseno, loantype, CAST(loan_amt AS numeric) as loan_amt,
        payment_date as disbursement_date, CAST(rate AS numeric) as rate,
        no_of_instal, CAST(instal_amt AS numeric) as instal_amt,
        CAST(balance AS numeric) as balance, purpose
      FROM loan_master
      WHERE CAST(mbno AS text) = $1
    `, [memberNo]);

    const loanContributions = [];
    let totalCredits = 0;
    let totalDebits = 0;
    let totalTransactions = 0;

    for (const loan of loans) {
      // 3. Get transactions for each loan within date range
      // In this system, transactions are stored in the 'ledger' table
      // We look for entries matching the loancaseno in narration or specific head_code if applicable
      const transactions = await this.dataSource.query(`
        SELECT 
          date as transaction_date,
          voucherno as voucher_no,
          particulars as narration,
          CAST(debit AS numeric) as debit,
          CAST(credit AS numeric) as credit
        FROM ledger
        WHERE mbno = $1 
          AND particulars LIKE '%' || $2 || '%'
          AND date >= $3 AND date <= $4
        ORDER BY date ASC
      `, [memberNo, loan.loancaseno, fromDate, toDate]);

      const mappedTransactions = transactions.map((t: any) => {
        const debit = parseFloat(t.debit) || 0;
        const credit = parseFloat(t.credit) || 0;
        totalDebits += debit;
        totalCredits += credit;
        totalTransactions++;

        return {
          transactionDate: t.transaction_date,
          transactionType: credit > 0 ? 'CR' : 'DR',
          transactionAmount: credit > 0 ? credit : debit,
          narration: t.narration,
          voucherNo: t.voucher_no
        };
      });

      loanContributions.push({
        loanDetails: {
          loanType: loan.loantype,
          loanCaseNo: loan.loancaseno,
          loanAmount: parseFloat(loan.loan_amt) || 0,
          disbursementDate: loan.disbursement_date,
          interestRate: parseFloat(loan.rate) || 0,
          numberOfInstallments: parseInt(loan.no_of_instal) || 0,
          installmentAmount: parseFloat(loan.instal_amt) || 0,
          outstandingBalance: parseFloat(loan.balance) || 0,
          purpose: loan.purpose
        },
        transactions: mappedTransactions
      });
    }

    return {
      memberNo: member.mbno,
      memberName: member.name,
      address: member.address || 'Address not available',
      fromDate,
      toDate,
      loanContributions,
      totalTransactions,
      summary: {
        totalDebits,
        totalCredits
      }
    };
  }
}
