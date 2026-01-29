import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

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
     * Get financial summary
     */
    async getFinancialSummary(dto: { fromDate: string; toDate: string }) {
        const { fromDate, toDate } = dto;

        // Get receipt totals
        const receiptQuery = `
      SELECT 
        SUM(COALESCE(rcash, 0)) as receipt_cash,
        SUM(COALESCE(rtransfer, 0)) as receipt_transfer
      FROM tblcashbook
      WHERE trans_date >= $1 AND trans_date <= $2
    `;
        const receiptResult = await this.dataSource.query(receiptQuery, [fromDate, toDate]);

        // Get payment totals
        const paymentQuery = `
      SELECT 
        SUM(COALESCE(pcash, 0)) as payment_cash,
        SUM(COALESCE(ptransfer, 0)) as payment_transfer
      FROM tblcashbook
      WHERE trans_date >= $1 AND trans_date <= $2
    `;
        const paymentResult = await this.dataSource.query(paymentQuery, [fromDate, toDate]);

        const receiptCash = parseFloat(receiptResult[0]?.receipt_cash) || 0;
        const receiptTransfer = parseFloat(receiptResult[0]?.receipt_transfer) || 0;
        const paymentCash = parseFloat(paymentResult[0]?.payment_cash) || 0;
        const paymentTransfer = parseFloat(paymentResult[0]?.payment_transfer) || 0;

        return {
            fromDate,
            toDate,
            receipts: {
                cash: receiptCash,
                transfer: receiptTransfer,
                total: receiptCash + receiptTransfer
            },
            payments: {
                cash: paymentCash,
                transfer: paymentTransfer,
                total: paymentCash + paymentTransfer
            },
            netBalance: (receiptCash + receiptTransfer) - (paymentCash + paymentTransfer)
        };
    }

    /**
     * Get account closing register
     */
    async getAccountClosingRegister(dto: { fromDate: string; toDate: string; accountType?: string }) {
        const { fromDate, toDate, accountType } = dto;

        let query = `
      SELECT 
        ac.account_no,
        ac.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        ac.account_type,
        ac.closing_date,
        ac.closing_amount,
        ac.closing_reason
      FROM account_closing_register ac
      LEFT JOIN member_master m ON m.mbno = ac.mbno
      WHERE ac.closing_date >= $1 AND ac.closing_date <= $2
    `;

        const params: any[] = [fromDate, toDate];

        if (accountType) {
            query += ` AND ac.account_type = $${params.length + 1}`;
            params.push(accountType);
        }

        query += ` ORDER BY ac.closing_date DESC`;

        const result = await this.dataSource.query(query, params);

        return result.map((r: any, idx: number) => ({
            key: idx.toString(),
            accountNo: r.account_no,
            memberNo: r.member_no,
            memberName: r.member_name,
            accountType: r.account_type,
            closingDate: r.closing_date,
            closingAmount: parseFloat(r.closing_amount) || 0,
            closingReason: r.closing_reason
        }));
    }

    /**
     * Get recovery details
     */
    async getRecoveryDetails(dto: { month: string; year: number; wingNo?: string }) {
        const { month, year, wingNo } = dto;

        const monthMap: { [key: string]: number } = {
            'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
            'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12
        };

        const monthNum = monthMap[month.substring(0, 3)];

        let query = `
      SELECT 
        m.mbno as member_no,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
        d.name as office_name,
        rd.recovery_type,
        rd.amount,
        rd.recovery_date
      FROM recovery_details rd
      LEFT JOIN member_master m ON m.mbno = rd.mbno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE EXTRACT(MONTH FROM rd.recovery_date) = $1
        AND EXTRACT(YEAR FROM rd.recovery_date) = $2
    `;

        const params: any[] = [monthNum, year];

        if (wingNo) {
            query += ` AND m.wingno = $${params.length + 1}`;
            params.push(wingNo);
        }

        query += ` ORDER BY rd.recovery_date, m.mbno`;

        const result = await this.dataSource.query(query, params);

        return result.map((r: any, idx: number) => ({
            key: idx.toString(),
            memberNo: r.member_no,
            memberName: r.member_name,
            officeName: r.office_name,
            recoveryType: r.recovery_type,
            amount: parseFloat(r.amount) || 0,
            recoveryDate: r.recovery_date
        }));
    }

    /**
     * Diagnostic check
     */
    async diagnosticCheck() {
        try {
            const memberCount = await this.dataSource.query(`SELECT COUNT(*)::text as count FROM member_master`);
            const loanCount = await this.dataSource.query(`SELECT COUNT(*)::text as count FROM loan_master`);
            const depositCount = await this.dataSource.query(`SELECT COUNT(*)::text as count FROM deposit_master`);

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
}
