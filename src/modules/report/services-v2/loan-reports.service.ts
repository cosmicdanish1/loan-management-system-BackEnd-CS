import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

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

    const params: any[] = [fromDate, toDate];
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

    // Calculate running balance (Note: Running balance for paginated ledger is mathematically difficult 
    // unless we fetch historical transactions. In this case, we'll return it as is or handle it 
    // differently if specific offsets are requested). For now, we calculate per-set balance.
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
  async getMemberLoanDetail(dto: { memberNo?: string; loanType?: string; limit?: number; offset?: number }) {
    const { limit, offset } = dto;

    const baseQuery = `
      FROM loan_master loan
      LEFT JOIN member_master m ON m.mbno = loan.mbno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE 1=1
    `;

    const params: any[] = [];
    let whereClause = '';

    if (dto.memberNo) {
      whereClause += ` AND loan.mbno = $${params.length + 1}`;
      params.push(dto.memberNo);
    }

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
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
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
      ORDER BY loan.mbno, loan.loancaseno
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
        balance: parseFloat(l.balance) || 0,
        interestRate: l.interest_rate,
        totalInstallments: l.total_installments,
        installmentAmount: parseFloat(l.installment_amount) || 0,
        disbursementDate: l.disbursement_date
      }))
    };
  }

  /**
   * Get surety register
   */
  async getSuretyRegister(dto: { memberNo?: string; limit?: number; offset?: number }) {
    const { limit, offset } = dto;

    const baseQuery = `
      FROM loan_pending lp
      LEFT JOIN member_master m ON m.mbno = lp.mbno
      LEFT JOIN member_master s1 ON s1.mbno = lp.g1mbno
      LEFT JOIN member_master s2 ON s2.mbno = lp.g2mbno
      WHERE 1=1
    `;

    const params: any[] = [];
    let whereClause = '';

    if (dto.memberNo) {
      whereClause += ` AND (lp.mbno = $${params.length + 1} OR lp.g1mbno = $${params.length + 1} OR lp.g2mbno = $${params.length + 1})`;
      params.push(dto.memberNo);
    }

    // Get total count
    const totalCountRes = await this.dataSource.query(`SELECT COUNT(*) ${baseQuery} ${whereClause}`, params);
    const totalCount = parseInt(totalCountRes[0].count);

    let query = `
      SELECT 
        lp.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        lp.loancaseno as loan_case_no,
        lp.loantype as loan_type,
        lp.sanctioned_amt as loan_amount,
        lp.g1mbno as surety1_no,
        TRIM(COALESCE(s1.f_name, '') || ' ' || COALESCE(s1.l_name, '')) as surety1_name,
        lp.g2mbno as surety2_no,
        TRIM(COALESCE(s2.f_name, '') || ' ' || COALESCE(s2.l_name, '')) as surety2_name
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

    return {
      metadata: {
        totalCount,
        limit: finalLimit,
        offset: offset || 0
      },
      data: result.map((r: any, idx: number) => ({
        key: ((offset || 0) + idx).toString(),
        memberNo: r.member_no,
        memberName: r.member_name,
        loanCaseNo: r.loan_case_no,
        loanType: r.loan_type,
        loanAmount: parseFloat(r.loan_amount) || 0,
        surety1: {
          memberNo: r.surety1_no,
          name: r.surety1_name
        },
        surety2: {
          memberNo: r.surety2_no,
          name: r.surety2_name
        }
      }))
    };
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
}
