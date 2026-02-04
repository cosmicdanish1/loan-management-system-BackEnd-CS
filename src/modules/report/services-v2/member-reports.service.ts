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
  async getVotersList(dto: {
    division?: string;
    branch?: string;
    memberStatus?: string;
    sortBy?: string;
    limit?: number;
    offset?: number
  }) {
    const { division, branch, memberStatus, sortBy, limit, offset } = dto;

    let baseQuery = `
      FROM member_master m
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      LEFT JOIN member_balances mb ON m.mbno = mb.mbno
      WHERE 1=1
    `;

    const params: any[] = [];
    let whereClause = '';

    if (division) {
      whereClause += ` AND d.name = $${params.length + 1}`;
      params.push(division);
    }

    if (branch) {
      // Branches are stored as officeno in member_master
      whereClause += ` AND m.officeno = $${params.length + 1}`;
      params.push(branch);
    }

    if (memberStatus === 'ACTIVE') {
      whereClause += ` AND (m.isactive = 'Y' OR m.isactive = '1')`;
    } else if (memberStatus === 'INACTIVE') {
      whereClause += ` AND (m.isactive = 'N' OR m.isactive = ' ' OR m.isactive IS NULL)`;
    }

    // Get total count
    const totalCountRes = await this.dataSource.query(`SELECT COUNT(*) ${baseQuery} ${whereClause}`, params);
    const totalCount = parseInt(totalCountRes[0].count);

    let orderBy = 'm.mbno::INTEGER'; // Cast to integer for correct numerical sorting
    if (sortBy === 'NAME') {
      orderBy = 'member_name';
    } else if (sortBy === 'DOJ') {
      orderBy = 'm.memb_date DESC';
    }

    let query = `
      SELECT 
        m.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        m.desig as designation,
        d.name as office_name,
        m.officeno as office_no,
        m.gross_salary as basic_pay,
        m.memb_date as membership_date,
        COALESCE(mb.shares, 0) as share_balance,
        m.isactive
      ${baseQuery} ${whereClause}
      ORDER BY ${orderBy}
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
      data: result.map((m: any, idx: number) => ({
        key: ((offset || 0) + idx).toString(),
        memberNo: m.member_no,
        memberName: m.member_name,
        designation: m.designation,
        officeName: m.office_name,
        officeNo: m.office_no,
        basicPay: parseFloat(m.basic_pay) || 0,
        membershipDate: m.membership_date,
        shareBalance: parseFloat(m.share_balance) || 0,
        isActive: m.isactive === 'Y' || m.isactive === '1'
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
   * Get annual member statement (from annualstatement table)
   */
  async getAnnualMemberStatement(dto: { wingNo?: string; officeNo?: string }) {
    const { wingNo, officeNo } = dto;

    let query = `
      SELECT 
        a.accno as "accountNo",
        COALESCE(a.op_triftamt, 0) as "opThriftAmount",
        COALESCE(a.cur_triftamt, 0) as "curThriftAmount",
        COALESCE(a.cur_tfintrec, 0) as "curThriftInterest",
        COALESCE(a.op_tfintrec, 0) as "opThriftInterest",
        COALESCE(a.op_shareamt, 0) as "opShareAmount",
        COALESCE(a.cur_shareamt, 0) as "curShareAmount",
        COALESCE(a.op_wfamt, 0) as "opWelfareAmount",
        COALESCE(a.cur_wfamt, 0) as "curWelfareAmount",
        COALESCE(a.rlbalance, 0) as "regularLoanBalance",
        COALESCE(a.tlbalance, 0) as "termLoanBalance",
        mm.mbno as "memberNo",
        TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) as "memberName",
        mm.wingno as "wingNo",
        mm.officeno as "officeNo"
      FROM annualstatement a
      LEFT JOIN member_master mm ON a.accno::text = mm.mbno::text
      WHERE 1=1
    `;

    const params: any[] = [];

    if (wingNo) {
      query += ` AND mm.wingno = $${params.length + 1}`;
      params.push(wingNo);
    }

    if (officeNo) {
      query += ` AND mm.officeno::text = $${params.length + 1}`;
      params.push(officeNo);
    }

    query += ` ORDER BY mm.mbno`;

    const result = await this.dataSource.query(query, params);

    // Fetch Society Details
    const societyDetails = await this.dataSource.query('SELECT * FROM society_details LIMIT 1');
    const society = societyDetails[0] || {};

    return {
      reportData: result.map((item, index) => ({
        key: index.toString(),
        accountNo: item.accountNo,
        opThriftAmount: parseFloat(item.opThriftAmount) || 0,
        curThriftAmount: parseFloat(item.curThriftAmount) || 0,
        curThriftInterest: parseFloat(item.curThriftInterest) || 0,
        opThriftInterest: parseFloat(item.opThriftInterest) || 0,
        opShareAmount: parseFloat(item.opShareAmount) || 0,
        curShareAmount: parseFloat(item.curShareAmount) || 0,
        opWelfareAmount: parseFloat(item.opWelfareAmount) || 0,
        curWelfareAmount: parseFloat(item.curWelfareAmount) || 0,
        regularLoanBalance: parseFloat(item.regularLoanBalance) || 0,
        termLoanBalance: parseFloat(item.termLoanBalance) || 0,
        memberNo: item.memberNo,
        memberName: item.memberName,
      })),
      societyName: society.name || 'EMP ESPAT EMPLOYEES CO-OP CREDIT SOCIETY LTD.',
      societyAddress: society.address || 'Sector 27A, Nigdi, Pradhikaran, Pune - 411044',
    };
  }

  /**
   * Get yearly member statement
   */
  async getYearlyMemberStatement(dto: { fromDate: string; toDate: string; wingNo?: string; officeNo?: string; fromMemberNo: string; toMemberNo: string; sortBy?: string }) {
    const { fromMemberNo, toMemberNo, wingNo, officeNo, sortBy = 'MBNO' } = dto;

    let query = `
      SELECT 
        mb.mbno as "memberNo",
        mb.member_name as "memberName",
        COALESCE(mb.shares, 0) as "shares",
        COALESCE(mb.compulsory_deposit, 0) as "compulsoryDeposit",
        COALESCE(mb.regularloan, 0) as "regularLoan",
        COALESCE(mb.emergency_loan_balance, 0) as "emergencyLoan"
      FROM member_balances mb
      LEFT JOIN member_master mm ON CAST(mb.mbno AS NUMERIC) = CAST(mm.mbno AS NUMERIC)
      WHERE CAST(mb.mbno AS NUMERIC) >= $1 AND CAST(mb.mbno AS NUMERIC) <= $2
    `;

    const params: any[] = [fromMemberNo, toMemberNo];

    if (wingNo) {
      query += ` AND mm.wingno = $${params.length + 1}`;
      params.push(wingNo);
    }

    if (officeNo) {
      query += ` AND mm.officeno::text = $${params.length + 1}`;
      params.push(officeNo);
    }

    // Add sorting
    if (sortBy === 'MBNO') {
      query += ` ORDER BY mb.mbno::numeric ASC`;
    } else if (sortBy === 'NAME') {
      query += ` ORDER BY mb.member_name ASC`;
    } else {
      query += ` ORDER BY mb.mbno::numeric ASC`;
    }

    const result = await this.dataSource.query(query, params);

    // Fetch Society Details
    const societyDetails = await this.dataSource.query('SELECT * FROM society_details LIMIT 1');
    const society = societyDetails[0] || {};

    return {
      data: result.map((item, index) => ({
        key: index.toString(),
        memberNo: item.memberNo,
        memberName: item.memberName || 'Unknown',
        shares: parseFloat(item.shares || 0).toFixed(2),
        compulsoryDeposit: parseFloat(item.compulsoryDeposit || 0).toFixed(2),
        regularLoan: parseFloat(item.regularLoan || 0).toFixed(2),
        emergencyLoan: parseFloat(item.emergencyLoan || 0).toFixed(2)
      })),
      societyName: society.name || 'EMP ESPAT EMPLOYEES CO-OP CREDIT SOCIETY LTD.',
      societyAddress: society.address || 'Sector 27A, Nigdi, Pradhikaran, Pune - 411044',
    };
  }

  /**
   * Get member ledger
   */
  async getMemberLedger(dto: { memberNo: string; fromDate: string; toDate: string }) {
    const { memberNo, fromDate, toDate } = dto;

    const query = `
      SELECT 
        l.trans_date as "transDate",
        l.trans_type as "transType",
        l.code as "code",
        l.trans_amt as "transAmt",
        l.narration as "narration",
        l.receipt_vchr_no as "voucherNo",
        l.ledgerid as "transTime"
      FROM ledger l
      WHERE l.mbno = $1
      AND l.trans_date >= $2::date
      AND l.trans_date <= $3::date
      ORDER BY l.trans_date ASC, l.ledgerid ASC
    `;

    const result = await this.dataSource.query(query, [memberNo, fromDate, toDate]);

    // Calculate running balance
    let runningBalance = 0;

    return result.map((item, index) => {
      const amount = parseFloat(item.transAmt || 0);

      // Update running balance based on transaction type
      if (item.transType === 'CR') {
        runningBalance += amount;
      } else if (item.transType === 'DR') {
        runningBalance -= amount;
      }

      return {
        key: index.toString(),
        transDate: item.transDate,
        transType: item.transType,
        code: item.code,
        transAmt: amount.toFixed(2),
        narration: item.narration || '',
        voucherNo: item.voucherNo || '',
        runningBalance: runningBalance.toFixed(2)
      };
    });
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

  /**
   * Get account balance report by member range
   */
  async getAccountBalanceReport(dto: { fromAccountNo: string; toAccountNo: string }) {
    const { fromAccountNo, toAccountNo } = dto;

    const query = `
      SELECT 
        m.mbno as "memberNo",
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '')) as "memberName",
        (COALESCE(mb.shares, 0) + COALESCE(mb.compulsory_deposit, 0) - COALESCE(mb.regularloan, 0) - COALESCE(mb.emergency_loan_balance, 0)) as "currentBalance"
      FROM member_master m
      LEFT JOIN member_balances mb ON m.mbno = mb.mbno
      WHERE m.mbno::numeric >= $1::numeric AND m.mbno::numeric <= $2::numeric
      ORDER BY m.mbno::numeric
    `;

    const result = await this.dataSource.query(query, [fromAccountNo, toAccountNo]);

    return {
      success: true,
      data: result.map((r, idx) => ({
        key: idx.toString(),
        memberNo: r.memberNo,
        memberName: r.memberName,
        currentBalance: parseFloat(r.currentBalance) || 0
      }))
    };
  }
}
