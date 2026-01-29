import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Deposit Reports Service - Handles deposit-related reports.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from report.service.ts for single responsibility
 */
@Injectable()
export class DepositReportsService {
    constructor(private readonly dataSource: DataSource) { }

    /**
     * Get FD statement
     */
    async getFDStatement(dto: { memberNo?: string; fromDate?: string; toDate?: string }) {
        let query = `
      SELECT 
        dm.account_no,
        dm.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        dm.deposit_type,
        dm.principal_amount,
        dm.interest_rate,
        dm.deposit_date,
        dm.maturity_date,
        dm.maturity_amount,
        dm.status
      FROM deposit_master dm
      LEFT JOIN member_master m ON m.mbno = dm.mbno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE dm.deposit_type = 'FD'
    `;

        const params: any[] = [];

        if (dto.memberNo) {
            query += ` AND dm.mbno = $${params.length + 1}`;
            params.push(dto.memberNo);
        }

        if (dto.fromDate) {
            query += ` AND dm.deposit_date >= $${params.length + 1}`;
            params.push(dto.fromDate);
        }

        if (dto.toDate) {
            query += ` AND dm.deposit_date <= $${params.length + 1}`;
            params.push(dto.toDate);
        }

        query += ` ORDER BY dm.deposit_date DESC`;

        const result = await this.dataSource.query(query, params);

        return result.map((r: any, idx: number) => ({
            key: idx.toString(),
            accountNo: r.account_no,
            memberNo: r.member_no,
            memberName: r.member_name,
            officeName: r.office_name,
            depositType: r.deposit_type,
            principalAmount: parseFloat(r.principal_amount) || 0,
            interestRate: parseFloat(r.interest_rate) || 0,
            depositDate: r.deposit_date,
            maturityDate: r.maturity_date,
            maturityAmount: parseFloat(r.maturity_amount) || 0,
            status: r.status
        }));
    }

    /**
     * Get RD statement
     */
    async getRDStatement(dto: { memberNo?: string; fromDate?: string; toDate?: string }) {
        let query = `
      SELECT 
        dm.account_no,
        dm.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        dm.deposit_type,
        dm.monthly_amount,
        dm.interest_rate,
        dm.deposit_date,
        dm.maturity_date,
        dm.total_deposited,
        dm.status
      FROM deposit_master dm
      LEFT JOIN member_master m ON m.mbno = dm.mbno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE dm.deposit_type = 'RD'
    `;

        const params: any[] = [];

        if (dto.memberNo) {
            query += ` AND dm.mbno = $${params.length + 1}`;
            params.push(dto.memberNo);
        }

        if (dto.fromDate) {
            query += ` AND dm.deposit_date >= $${params.length + 1}`;
            params.push(dto.fromDate);
        }

        if (dto.toDate) {
            query += ` AND dm.deposit_date <= $${params.length + 1}`;
            params.push(dto.toDate);
        }

        query += ` ORDER BY dm.deposit_date DESC`;

        const result = await this.dataSource.query(query, params);

        return result.map((r: any, idx: number) => ({
            key: idx.toString(),
            accountNo: r.account_no,
            memberNo: r.member_no,
            memberName: r.member_name,
            officeName: r.office_name,
            depositType: r.deposit_type,
            monthlyAmount: parseFloat(r.monthly_amount) || 0,
            interestRate: parseFloat(r.interest_rate) || 0,
            depositDate: r.deposit_date,
            maturityDate: r.maturity_date,
            totalDeposited: parseFloat(r.total_deposited) || 0,
            status: r.status
        }));
    }

    /**
     * Get saving statement (Passbook view)
     */
    async getSavingStatement(dto: { memberNo: string; fromDate?: string; toDate?: string; headCode?: string }) {
        const { memberNo, fromDate, toDate, headCode = 'L1004' } = dto;

        // 1. Get member info
        const memberQuery = `
            SELECT 
                TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
                COALESCE(mb.compulsory_deposit, 0) as cd_balance
            FROM member_master m
            LEFT JOIN member_balances mb ON m.mbno = mb.mbno
            WHERE m.mbno = $1
        `;
        const memberResult = await this.dataSource.query(memberQuery, [memberNo]);
        if (memberResult.length === 0) return null;
        const member = memberResult[0];

        // 2. Calculate Opening Balance (Sum of all transactions before fromDate)
        let openingBalance = 0;
        if (fromDate) {
            const opBalQuery = `
                SELECT SUM(CASE WHEN trans_type = 'R' THEN trans_amt::numeric ELSE -trans_amt::numeric END) as balance
                FROM ledger
                WHERE mbno = $1 AND code = $2 AND trans_date < $3
            `;
            const opBalResult = await this.dataSource.query(opBalQuery, [memberNo, headCode, fromDate]);
            openingBalance = parseFloat(opBalResult[0]?.balance || '0');
        }

        // 3. Get transactions within date range
        let transQuery = `
            SELECT 
                trans_date as date,
                trans_type as type,
                trans_amt::numeric as amount,
                narration,
                receipt_vchr_no as voucher_no
            FROM ledger
            WHERE mbno = $1 AND code = $2
        `;

        const params: any[] = [memberNo, headCode];
        if (fromDate) {
            transQuery += ` AND trans_date >= $${params.length + 1}`;
            params.push(fromDate);
        }
        if (toDate) {
            transQuery += ` AND trans_date <= $${params.length + 1}`;
            params.push(toDate);
        }

        transQuery += ` ORDER BY trans_date ASC, trans_no ASC`;
        const transactions = await this.dataSource.query(transQuery, params);

        // 4. Calculate Running Balances
        let currentBalance = openingBalance;
        const formattedTransactions = transactions.map((t: any, idx: number) => {
            const deposit = t.type === 'R' ? parseFloat(t.amount) : 0;
            const withdrawal = t.type === 'P' ? parseFloat(t.amount) : 0;
            currentBalance += (deposit - withdrawal);

            return {
                key: idx.toString(),
                date: t.date,
                voucherNo: t.voucher_no,
                particulars: t.narration || (deposit > 0 ? 'Deposit' : 'Withdrawal'),
                withdrawal,
                deposit,
                balance: currentBalance
            };
        });

        return {
            memberNo,
            memberName: member.member_name,
            openingBalance,
            closingBalance: currentBalance,
            currentBalance: parseFloat(member.cd_balance) || 0, // Current total balance for comparison
            transactions: formattedTransactions
        };
    }

    /**
     * Get deposit maturity report
     */
    async getDepositMaturity(dto: { fromDate: string; toDate: string; depositType?: string }) {
        const { fromDate, toDate, depositType } = dto;

        let query = `
      SELECT 
        dm.account_no,
        dm.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        dm.deposit_type,
        dm.principal_amount,
        dm.maturity_amount,
        dm.maturity_date
      FROM deposit_master dm
      LEFT JOIN member_master m ON m.mbno = dm.mbno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE dm.maturity_date >= $1 AND dm.maturity_date <= $2
        AND dm.status = 'ACTIVE'
    `;

        const params: any[] = [fromDate, toDate];

        if (depositType) {
            query += ` AND dm.deposit_type = $${params.length + 1}`;
            params.push(depositType);
        }

        query += ` ORDER BY dm.maturity_date ASC`;

        const result = await this.dataSource.query(query, params);

        return result.map((r: any, idx: number) => ({
            key: idx.toString(),
            accountNo: r.account_no,
            memberNo: r.member_no,
            memberName: r.member_name,
            officeName: r.office_name,
            depositType: r.deposit_type,
            principalAmount: parseFloat(r.principal_amount) || 0,
            maturityAmount: parseFloat(r.maturity_amount) || 0,
            maturityDate: r.maturity_date
        }));
    }

    /**
     * Get FD certificate
     */
    async getFixedDepositCertificate(dto: { accountNo: string }) {
        const { accountNo } = dto;

        const query = `
      SELECT 
        dm.account_no,
        dm.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        m.present_address as address,
        d.name as office_name,
        dm.principal_amount,
        dm.interest_rate,
        dm.deposit_date,
        dm.maturity_date,
        dm.maturity_amount,
        dm.duration_months
      FROM deposit_master dm
      LEFT JOIN member_master m ON m.mbno = dm.mbno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE dm.account_no = $1
    `;

        const result = await this.dataSource.query(query, [accountNo]);

        if (result.length === 0) {
            return null;
        }

        const r = result[0];
        return {
            accountNo: r.account_no,
            memberNo: r.member_no,
            memberName: r.member_name,
            address: r.address,
            officeName: r.office_name,
            principalAmount: parseFloat(r.principal_amount) || 0,
            interestRate: parseFloat(r.interest_rate) || 0,
            depositDate: r.deposit_date,
            maturityDate: r.maturity_date,
            maturityAmount: parseFloat(r.maturity_amount) || 0,
            durationMonths: r.duration_months
        };
    }

    /**
     * Get share certificate
     */
    async getShareCertificate(dto: { memberNo: string }) {
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
}
