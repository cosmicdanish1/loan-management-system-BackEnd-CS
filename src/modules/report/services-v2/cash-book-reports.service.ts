import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Cash Book Reports Service - Handles cash book and ledger reports.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from report.service.ts for single responsibility
 */
@Injectable()
export class CashBookReportsService {
    constructor(private readonly dataSource: DataSource) { }

    /**
     * Get monthly cash book summary
     */
    /**
     * Get monthly cash book summary
     */
    async getCashBookMonthly(dto: { month: string; year: number; limit?: number; offset?: number }) {
        const { month, year, limit, offset } = dto;

        const monthMap: { [key: string]: number } = {
            'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
            'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
        };

        const monthIndex = monthMap[month.substring(0, 3)];
        const startDate = new Date(year, monthIndex, 1);
        const endDate = new Date(year, monthIndex + 1, 0);

        const startStr = startDate.toISOString().split('T')[0];
        const endStr = endDate.toISOString().split('T')[0];

        // Get total count (using subquery to count groups)
        const countRes = await this.dataSource.query(`
            SELECT COUNT(DISTINCT headcode) as count 
            FROM tblcashbook 
            WHERE trans_date >= $1 AND trans_date <= $2
        `, [startStr, endStr]);
        const totalCount = parseInt(countRes[0].count);

        let query = `
      SELECT 
        headcode as code,
        MAX(headname) as "headName",
        SUM(COALESCE(rcash, 0) + COALESCE(rtransfer, 0)) as receipt,
        SUM(COALESCE(pcash, 0) + COALESCE(ptransfer, 0)) as payment
      FROM tblcashbook
      WHERE trans_date IS NOT NULL
        AND trans_date >= $1
        AND trans_date <= $2
      GROUP BY headcode
      ORDER BY headcode
    `;

        const params: any[] = [startStr, endStr];
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
            data: result.map((item: any, index: number) => ({
                key: ((offset || 0) + index).toString(),
                code: item.code || '',
                headName: item.headName || 'Unknown Head',
                receipt: parseFloat(item.receipt) || 0,
                payment: parseFloat(item.payment) || 0,
            }))
        };
    }

    /**
     * Get detail ledger for a head code
     */
    async getDetailLedger(dto: { head_code: string; from_date: string; to_date: string; limit?: number; offset?: number }) {
        const { head_code, from_date, to_date, limit, offset } = dto;

        // Get head name
        const headResult = await this.dataSource.query(
            `SELECT head_name FROM head_master WHERE code = $1`,
            [head_code]
        );
        const headName = headResult[0]?.head_name || 'Unknown Head';

        // Get total count
        const countRes = await this.dataSource.query(`
            SELECT COUNT(*) FROM ledger WHERE code = $1 AND trans_date >= $2 AND trans_date <= $3
        `, [head_code, from_date, to_date]);
        const totalCount = parseInt(countRes[0].count);

        // Get transactions
        let query = `
      SELECT 
        trans_date,
        receipt_vchr_no as voucher_no,
        narration,
        trans_type,
        trans_amt as amount
      FROM ledger
      WHERE code = $1 AND trans_date >= $2 AND trans_date <= $3
      ORDER BY trans_date ASC, trans_no ASC
    `;

        const params: any[] = [head_code, from_date, to_date];
        if (limit !== undefined) {
            query += ` LIMIT $${params.length + 1}`;
            params.push(limit);
        }
        if (offset !== undefined) {
            query += ` OFFSET $${params.length + 1}`;
            params.push(offset);
        }

        const transactions = await this.dataSource.query(query, params);

        // Calculate running balance (per-set)
        let runningBalance = 0;
        const parseMoneyString = (moneyStr: any): number => {
            if (!moneyStr) return 0;
            const str = moneyStr.toString();
            const cleanStr = str.replace(/[₹$,\s?]/g, '');
            return parseFloat(cleanStr) || 0;
        };

        const ledgerData = transactions.map((trans: any, index: number) => {
            const isDebit = trans.trans_type === 'DR';
            const amount = parseMoneyString(trans.amount);
            const debit = isDebit ? amount : 0;
            const credit = !isDebit ? amount : 0;

            runningBalance += debit - credit;

            return {
                key: ((offset || 0) + index).toString(),
                date: trans.trans_date,
                voucherNo: trans.voucher_no || '-',
                narration: trans.narration || '',
                debit: debit,
                credit: credit,
                balance: runningBalance
            };
        });

        return {
            metadata: {
                totalCount,
                limit: limit || totalCount,
                offset: offset || 0
            },
            headCode: head_code,
            headName: headName,
            fromDate: from_date,
            toDate: to_date,
            transactions: ledgerData
        };
    }

    /**
     * Get bank detail ledger
     */
    async getBankDetailLedger(dto: { bank_head_code: string; from_date: string; to_date: string; limit?: number; offset?: number }) {
        const { bank_head_code, from_date, to_date, limit, offset } = dto;

        // Get bank name
        const bankResult = await this.dataSource.query(
            `SELECT head_name FROM head_master WHERE code = $1`,
            [bank_head_code]
        );
        const bankName = bankResult[0]?.head_name || 'Unknown Bank';

        // Get total count
        const countRes = await this.dataSource.query(`
            SELECT COUNT(*) FROM ledger WHERE code = $1 AND trans_date >= $2 AND trans_date <= $3
        `, [bank_head_code, from_date, to_date]);
        const totalCount = parseInt(countRes[0].count);

        // Get transactions
        let query = `
      SELECT 
        trans_date,
        receipt_vchr_no as voucher_no,
        narration,
        trans_type,
        CAST(trans_amt AS numeric) as amount
      FROM ledger
      WHERE code = $1 AND trans_date >= $2 AND trans_date <= $3
      ORDER BY trans_date ASC, trans_no ASC
    `;

        const params: any[] = [bank_head_code, from_date, to_date];
        if (limit !== undefined) {
            query += ` LIMIT $${params.length + 1}`;
            params.push(limit);
        }
        if (offset !== undefined) {
            query += ` OFFSET $${params.length + 1}`;
            params.push(offset);
        }

        const transactions = await this.dataSource.query(query, params);

        const openingBalance = 0;
        let runningBalance = openingBalance;
        const ledgerData = transactions.map((trans: any, index: number) => {
            const isDebit = trans.trans_type === 'DR';
            const debit = isDebit ? parseFloat(trans.amount) || 0 : 0;
            const credit = !isDebit ? parseFloat(trans.amount) || 0 : 0;

            runningBalance += debit - credit;

            return {
                key: ((offset || 0) + index).toString(),
                date: trans.trans_date,
                voucherNo: trans.voucher_no || '-',
                narration: trans.narration || '',
                debit: debit,
                credit: credit,
                balance: runningBalance
            };
        });

        return {
            metadata: {
                totalCount,
                limit: limit || totalCount,
                offset: offset || 0
            },
            bankCode: bank_head_code,
            bankName: bankName,
            fromDate: from_date,
            toDate: to_date,
            openingBalance: openingBalance,
            transactions: ledgerData
        };
    }

    /**
     * Get list of all account heads
     */
    async getHeadList() {
        const heads = await this.dataSource.query(`
      SELECT code, head_name FROM head_master ORDER BY head_name ASC
    `);

        return heads.map((h: any) => ({
            code: h.code,
            name: h.head_name
        }));
    }

    /**
     * Get list of bank account heads
     */
    async getBankList() {
        const banks = await this.dataSource.query(`
      SELECT code, head_name FROM head_master 
      WHERE UPPER(head_name) LIKE '%BANK%' OR UPPER(head_name) LIKE '%ACCOUNT%'
      ORDER BY head_name ASC
    `);

        return banks.map((b: any) => ({
            code: b.code,
            name: b.head_name
        }));
    }
}
