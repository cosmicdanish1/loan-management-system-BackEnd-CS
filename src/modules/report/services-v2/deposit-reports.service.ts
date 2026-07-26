import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { parseSafeDate } from '../../shared/utils/date-utils';

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
        fd."accountNumber" as account_no,
        fd."memberId" as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        'FD' as deposit_type,
        CAST(fd."principalAmount" AS numeric) as principal_amount,
        CAST(fd."interestRate" AS numeric) as interest_rate,
        fd."depositDate" as deposit_date,
        fd."maturityDate" as maturity_date,
        CAST(fd."maturityAmount" AS numeric) as maturity_amount,
        fd."tenureMonths" as tenure_months,
        fd.status
      FROM fixed_deposits fd
      LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(fd."memberId" AS text)
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE 1=1
    `;

        const params: any[] = [];

        if (dto.memberNo) {
            query += ` AND CAST(fd."memberId" AS text) = $${params.length + 1}`;
            params.push(dto.memberNo);
        }

        if (dto.fromDate) {
            query += ` AND fd."depositDate" >= $${params.length + 1}`;
            params.push(parseSafeDate(dto.fromDate));
        }

        if (dto.toDate) {
            query += ` AND fd."depositDate" <= $${params.length + 1}`;
            params.push(parseSafeDate(dto.toDate));
        }

        query += ` ORDER BY fd."depositDate" DESC`;

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
            tenureMonths: r.tenure_months,
            status: r.status
        }));
    }

    /**
     * Get RD statement
     */
    async getRDStatement(dto: { memberNo?: string; fromDate?: string; toDate?: string }) {
        let query = `
      SELECT 
        rd."accountNumber" as account_no,
        rd."memberId" as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        'RD' as deposit_type,
        CAST(rd."monthlyInstallment" AS numeric) as monthly_amount,
        CAST(rd."interestRate" AS numeric) as interest_rate,
        rd."startDate" as deposit_date,
        rd."maturityDate" as maturity_date,
        CAST(rd."totalDeposited" AS numeric) as total_deposited,
        CAST(rd."maturityAmount" AS numeric) as maturity_amount,
        rd."tenureMonths" as tenure_months,
        rd."installmentsPaid" as installments_paid,
        rd."installmentsMissed" as installments_missed,
        rd.status
      FROM recurring_deposits rd
      LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(rd."memberId" AS text)
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE 1=1
    `;

        const params: any[] = [];

        if (dto.memberNo) {
            query += ` AND CAST(rd."memberId" AS text) = $${params.length + 1}`;
            params.push(dto.memberNo);
        }

        if (dto.fromDate) {
            query += ` AND rd."startDate" >= $${params.length + 1}`;
            params.push(parseSafeDate(dto.fromDate));
        }

        if (dto.toDate) {
            query += ` AND rd."startDate" <= $${params.length + 1}`;
            params.push(parseSafeDate(dto.toDate));
        }

        query += ` ORDER BY rd."startDate" DESC`;

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
            maturityAmount: parseFloat(r.maturity_amount) || 0,
            tenureMonths: r.tenure_months,
            installmentsPaid: r.installments_paid,
            installmentsMissed: r.installments_missed,
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
            LIMIT 1
        `;
        const memberResult = await this.dataSource.query(memberQuery, [memberNo]);
        if (memberResult.length === 0) return null;
        const member = memberResult[0];

        // 2. Calculate Opening Balance (Sum of all transactions before fromDate)
        let openingBalance = 0;
        if (fromDate) {
            const opBalQuery = `
                SELECT SUM(CASE WHEN trans_type IN ('CR', 'R') THEN trans_amt::numeric ELSE -trans_amt::numeric END) as balance
                FROM ledger
                WHERE mbno = $1 AND code = $2 AND trans_date < $3
            `;
            const opBalResult = await this.dataSource.query(opBalQuery, [memberNo, headCode, parseSafeDate(fromDate)]);
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
            params.push(parseSafeDate(fromDate));
        }
        if (toDate) {
            transQuery += ` AND trans_date <= $${params.length + 1}`;
            params.push(parseSafeDate(toDate));
        }

        transQuery += ` ORDER BY trans_date ASC, trans_no ASC`;
        const transactions = await this.dataSource.query(transQuery, params);

        // 4. Calculate Running Balances
        let currentBalance = openingBalance;
        const formattedTransactions = transactions.map((t: any, idx: number) => {
            // Handle both CR/DR and R/P transaction types
            const deposit = (t.type === 'CR' || t.type === 'R') ? parseFloat(t.amount) : 0;
            const withdrawal = (t.type === 'DR' || t.type === 'P') ? parseFloat(t.amount) : 0;
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

        // Query fixed deposits
        let fdQuery = `
      SELECT
        fd."accountNumber" as account_no,
        fd."memberId" as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        'Fixed Deposit' as deposit_type,
        CAST(fd."principalAmount" AS numeric) as amount,
        fd."depositDate" as deposit_date,
        fd."maturityDate" as due_date,
        CAST(fd."interestRate" AS numeric) as interest_rate,
        CAST(fd."maturityAmount" AS numeric) as maturity_amount
      FROM fixed_deposits fd
      LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(fd."memberId" AS text)
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE fd."maturityDate" >= $1 AND fd."maturityDate" <= $2
        AND fd.status = 'ACTIVE'
    `;

        // Query recurring deposits
        let rdQuery = `
      SELECT
        rd."accountNumber" as account_no,
        rd."memberId" as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        'Recurring Deposit' as deposit_type,
        CAST(rd."monthlyInstallment" AS numeric) as amount,
        rd."startDate" as deposit_date,
        rd."maturityDate" as due_date,
        CAST(rd."interestRate" AS numeric) as interest_rate,
        CAST(rd."maturityAmount" AS numeric) as maturity_amount
      FROM recurring_deposits rd
      LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(rd."memberId" AS text)
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE rd."maturityDate" >= $1 AND rd."maturityDate" <= $2
        AND rd.status = 'ACTIVE'
    `;

        const params: any[] = [parseSafeDate(fromDate), parseSafeDate(toDate)];

        // If deposit type is specified, only query that type
        let query = '';
        if (depositType === 'Fixed Deposit') {
            query = fdQuery + ` ORDER BY fd."maturityDate" ASC`;
        } else if (depositType === 'Recurring Deposit') {
            query = rdQuery + ` ORDER BY rd."maturityDate" ASC`;
        } else {
            // Union both queries for all types
            query = `(${fdQuery}) UNION ALL (${rdQuery}) ORDER BY due_date ASC`;
        }

        const result = await this.dataSource.query(query, params);

        return result.map((r: any, idx: number) => ({
            key: idx.toString(),
            accountNo: r.account_no,
            memberNo: r.member_no,
            memberName: r.member_name,
            depositType: r.deposit_type,
            amount: parseFloat(r.amount) || 0,
            depositDate: r.deposit_date,
            dueDate: r.due_date,
            interestRate: parseFloat(r.interest_rate) || 0,
            maturityAmount: parseFloat(r.maturity_amount) || 0
        }));
    }

    /**
     * Get FD certificate
     */
    async getFixedDepositCertificate(dto: { memberNo: string; accountNo?: string; certificateNo?: string }) {
        const { memberNo, accountNo, certificateNo } = dto;

        let query = `
      SELECT
        fd."accountNumber" as account_no,
        fd."memberId" as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        m.present_address as address,
        d.name as office_name,
        CAST(fd."principalAmount" AS numeric) as principal_amount,
        CAST(fd."interestRate" AS numeric) as interest_rate,
        fd."depositDate" as deposit_date,
        fd."maturityDate" as maturity_date,
        CAST(fd."maturityAmount" AS numeric) as maturity_amount,
        fd."tenureMonths" as duration_months
      FROM fixed_deposits fd
      LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(fd."memberId" AS text)
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE CAST(fd."memberId" AS text) = $1
    `;

        const params: any[] = [memberNo];
        if (accountNo) {
            query += ` AND fd."accountNumber" = $2`;
            params.push(accountNo);
        }

        const result = await this.dataSource.query(query, params);

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
    async getShareCertificate(dto: { memberNo: string; certificateNo?: string }) {
        const { memberNo } = dto;

        const query = `
      SELECT 
        m.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        m.present_address as address,
        m.memb_date as membership_date,
        d.name as office_name,
        COALESCE((SELECT shareamt FROM fundsmaster WHERE mbno = m.mbno LIMIT 1), 0) as share_balance
      FROM member_master m
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE CAST(m.mbno AS text) = $1
      LIMIT 1
    `;

        const result = await this.dataSource.query(query, [memberNo]);

        if (result.length === 0) {
            return null;
        }

        const r = result[0];
        return {
            memberNo: r.member_no,
            memberName: r.member_name,
            address: r.address || 'Address not available',
            membershipDate: r.membership_date,
            officeName: r.office_name || 'Not specified',
            shareBalance: parseFloat(r.share_balance) || 0
        };
    }

    /**
     * Get recurring details
     */
    async getRecurringDetails(dto: { memberNo: string }) {
        const { memberNo } = dto;

        const query = `
      SELECT
        rd."accountNumber" as account_no,
        rd."memberId" as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        'RD' as account_type,
        rd."startDate" as start_date,
        rd."maturityDate" as maturity_date,
        CAST(rd."monthlyInstallment" AS numeric) as amount,
        rd."installmentsPaid" as installments_paid,
        rd."installmentsMissed" as installments_missed,
        CAST(rd."totalDeposited" AS numeric) as total_deposited,
        rd.status
      FROM recurring_deposits rd
      LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(rd."memberId" AS text)
      WHERE CAST(rd."memberId" AS text) = $1
    `;

        const result = await this.dataSource.query(query, [memberNo]);

        return result.map((r: any, idx: number) => ({
            key: idx.toString(),
            accountNo: r.account_no,
            memberNo: r.member_no,
            memberName: r.member_name,
            startDate: r.start_date,
            maturityDate: r.maturity_date,
            amount: parseFloat(r.amount) || 0,
            installmentsPaid: r.installments_paid,
            installmentsMissed: r.installments_missed,
            totalDeposited: parseFloat(r.total_deposited) || 0,
            status: r.status
        }));
    }

    /**
     * Get lien account information
     */
    async getLienAccountInformation() {
        const query = `
      SELECT
        l.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        m.present_address as address,
        l.loancaseno as loan_case_no,
        l.fdrd_accountnumber as fdrd_account_no,
        l.fromdate as lien_from_date,
        COALESCE(CAST(lm.loan_amt AS numeric), 0) as loan_amount,
        COALESCE(CAST(lm.balance AS numeric), 0) as loan_balance,
        lm.payment_date as loan_date,
        lm.loantype as loan_type,
        fd."accountNumber" as fd_account_no,
        COALESCE(CAST(fd."principalAmount" AS numeric), 0) as fd_amount,
        COALESCE(CAST(fd."interestRate" AS numeric), 0) as fd_rate,
        fd."depositDate" as fd_deposit_date,
        fd."maturityDate" as fd_maturity_date
      FROM fdrdlienmaster l
      LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(l.mbno AS text)
      LEFT JOIN loan_master lm ON CAST(lm.loancaseno AS text) = CAST(l.loancaseno AS text)
        AND CAST(lm.mbno AS text) = CAST(l.mbno AS text)
      LEFT JOIN fixed_deposits fd ON fd."accountNumber" = l.fdrd_accountnumber
      ORDER BY l.fromdate DESC
    `;

        const results = await this.dataSource.query(query);

        return results.map((r: any, idx: number) => ({
            key: idx.toString(),
            memberNo: r.member_no,
            memberName: r.member_name,
            address: r.address || 'Address not available',
            loanCaseNo: r.loan_case_no,
            fdrdAccountNumber: r.fdrd_account_no,
            lienFromDate: r.lien_from_date,
            accountDetails: {
                certificateNo: r.fdrd_account_no || '',
                accountAmount: parseFloat(r.fd_amount) || 0,
                interestRate: parseFloat(r.fd_rate) || 0,
                depositDate: r.fd_deposit_date,
                maturityDate: r.fd_maturity_date,
                accountType: r.fd_account_no ? 'Fixed Deposit' : 'FD/RD',
            },
            loanDetails: {
                loanAmount: parseFloat(r.loan_amount) || 0,
                loanBalance: parseFloat(r.loan_balance) || 0,
                loanDate: r.loan_date,
                loanType: r.loan_type || 'Not specified'
            }
        }));
    }

    /**
     * Get passbook printing data.
     * Tracking from bank_passbook; transactions from ledger (pivoted by acc_type).
     *
     * Deposit columns: SHR→Share, CD→Compulsory Deposit, MD1→FRS-1, MD2→FRS-2
     * Loan columns:    RLN→Regular Loan, ALN→Emergency Loan
     */
    async getPassBookPrinting(dto: {
        memberNo: string;
        accountType?: string;
        fromDate?: string;
        toDate?: string;
    }) {
        const mbno = (dto.memberNo || '').trim();

        // 1. Member info
        const memberRes = await this.dataSource.query(`
            SELECT CAST(mbno AS text) AS "memberNo",
              TRIM(COALESCE(f_name,'')||' '||COALESCE(m_name,'')||' '||COALESCE(l_name,'')) AS "memberName",
              present_address AS "address",
              memb_date AS "membershipDate",
              pfno AS "pfNo"
            FROM member_master WHERE CAST(mbno AS text) = $1
        `, [mbno]);
        const memberDetails = memberRes[0] || { memberNo: mbno, memberName: '', address: '', membershipDate: null, pfNo: '' };

        // 2. Print-tracking (bank_passbook.account_number = ledger.mbno)
        const tracking = await this.dataSource.query(`
            SELECT TRIM(account_number) AS "accountNumber",
              accounttype AS "accountType",
              tr_date AS "trDate",
              CAST(ledgerid AS bigint) AS "ledgerId",
              lastlineno AS "lastLineNo",
              row_id AS "rowId",
              printedon AS "printedOn"
            FROM bank_passbook
            WHERE TRIM(account_number) = $1
            ORDER BY accounttype
        `, [mbno]);

        const depositTracking = tracking.find((t: any) => t.accountType === 'D') || null;
        const loanTracking    = tracking.find((t: any) => t.accountType === 'L') || null;

        const lastDepositId = Number(depositTracking?.ledgerId ?? 0);
        const lastLoanId    = Number(loanTracking?.ledgerId ?? 0);

        // 3. Pivoted deposit transactions
        // SHR→Share, CD/MD→Compulsory Deposit (FD cols), MD1→FRS-1, MD2→FRS-2
        const depositRows = await this.dataSource.query(`
            SELECT
              trans_date AS "transDate",
              receipt_vchr_no AS "vchrNo",
              COALESCE(SUM(CASE WHEN acc_type='SHR' AND trans_type='DR' THEN trans_amt END), 0) AS "SH_Dr_Amt",
              COALESCE(SUM(CASE WHEN acc_type='SHR' AND trans_type='CR' THEN trans_amt END), 0) AS "SH_Cr_Amt",
              COALESCE(MAX(CASE WHEN acc_type='SHR'                      THEN pl_balance  END), 0) AS "SH_Bal_Amt",
              COALESCE(SUM(CASE WHEN acc_type IN ('CD','MD') AND trans_type='DR' THEN trans_amt END), 0) AS "FD_Dr_Amt",
              COALESCE(SUM(CASE WHEN acc_type IN ('CD','MD') AND trans_type='CR' THEN trans_amt END), 0) AS "FD_Cr_Amt",
              COALESCE(MAX(CASE WHEN acc_type IN ('CD','MD')              THEN pl_balance  END), 0) AS "FD_Bal_Amt",
              COALESCE(SUM(CASE WHEN acc_type='MD1' AND trans_type='DR'  THEN trans_amt END), 0) AS "FRS_Dr_Amt",
              COALESCE(SUM(CASE WHEN acc_type='MD1' AND trans_type='CR'  THEN trans_amt END), 0) AS "FRS_Cr_Amt",
              COALESCE(SUM(CASE WHEN acc_type='MD2' AND trans_type='CR'  THEN trans_amt END), 0) AS "FRS_Cr_Amt1",
              MAX(ledgerid) AS "maxLedgerId"
            FROM ledger
            WHERE CAST(mbno AS text) = $1
              AND ledgerid > $2
              AND acc_type IN ('SHR','CD','MD','MD1','MD2')
            GROUP BY trans_date, receipt_vchr_no
            ORDER BY trans_date, MAX(ledgerid)
        `, [mbno, lastDepositId]);

        // 4. Pivoted loan transactions (acc_type: RLN, ALN, ELN)
        const loanRows = await this.dataSource.query(`
            SELECT
              trans_date AS "transDate",
              receipt_vchr_no AS "vchrNo",
              COALESCE(SUM(CASE WHEN acc_type='RLN' AND trans_type='DR'         THEN trans_amt END), 0) AS "RLN_Dr_Amt",
              COALESCE(SUM(CASE WHEN acc_type='RLN' AND trans_type='CR'         THEN trans_amt END), 0) AS "RLN_Cr_Amt",
              COALESCE(MAX(CASE WHEN acc_type='RLN'                             THEN pl_balance  END), 0) AS "RLN_Bal_Amt",
              COALESCE(SUM(CASE WHEN acc_type IN ('ALN','ELN') AND trans_type='DR' THEN trans_amt END), 0) AS "ALN_Dr_Amt",
              COALESCE(SUM(CASE WHEN acc_type IN ('ALN','ELN') AND trans_type='CR' THEN trans_amt END), 0) AS "ALN_Cr_Amt",
              COALESCE(MAX(CASE WHEN acc_type IN ('ALN','ELN')                  THEN pl_balance  END), 0) AS "ALN_Bal_Amt",
              MAX(ledgerid) AS "maxLedgerId"
            FROM ledger
            WHERE CAST(mbno AS text) = $1
              AND ledgerid > $2
              AND acc_type IN ('RLN','ALN','ELN')
            GROUP BY trans_date, receipt_vchr_no
            ORDER BY trans_date, MAX(ledgerid)
        `, [mbno, lastLoanId]);

        return {
            memberDetails,
            depositTracking,
            loanTracking,
            allTracking: tracking,
            depositRows,
            loanRows,
            totalDepositRows: depositRows.length,
            totalLoanRows: loanRows.length,
        };
    }

    /** Reset passbook print tracking — set ledgerid=0 so everything re-prints */
    async resetPassbookPrinting(memberNo: string, accountType?: string) {
        const mbno = memberNo.trim();
        const params: any[] = [mbno];
        let q = `UPDATE bank_passbook SET ledgerid=0, lastlineno=0, tr_date=NULL WHERE TRIM(account_number)=$1`;
        if (accountType) { params.push(accountType); q += ` AND accounttype=$2`; }
        await this.dataSource.query(q, params);
        return { success: true, message: 'Passbook printing reset successfully' };
    }

    /** Update bank_passbook tracking after a successful print */
    async updatePassbookTracking(memberNo: string, accountType: string, lastLedgerId: number, lastLineNo: number) {
        await this.dataSource.query(`
            UPDATE bank_passbook
            SET ledgerid=$1, lastlineno=$2, tr_date=NOW(), printedon=NOW()
            WHERE TRIM(account_number)=$3 AND accounttype=$4
        `, [lastLedgerId, lastLineNo, memberNo.trim(), accountType]);
        return { success: true };
    }
}
