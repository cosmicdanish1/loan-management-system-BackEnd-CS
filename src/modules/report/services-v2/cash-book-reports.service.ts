import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { parseSafeDate } from '../../shared/utils/date-utils';

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
     * Get daily cash book report (voucher-wise) - Using legacy ledger table
     */
    async getCashBookDaily(date: string) {
        const targetDate = parseSafeDate(date);

        // Get all unique vouchers for the date from ledger
        const vouchers = await this.dataSource.query(`
            SELECT DISTINCT 
                receipt_vchr_no as voucher_no,
                mbno as member_no,
                vchr_type as voucher_type,
                modeofpay as mode_of_payment
            FROM ledger
            WHERE trans_date::date = $1::date
            AND receipt_vchr_no IS NOT NULL 
            AND receipt_vchr_no != ''
            ORDER BY receipt_vchr_no
        `, [targetDate]);

        // For each voucher, get transactions
        const voucherDetails = await Promise.all(vouchers.map(async (voucher: any) => {
            const transactions = await this.dataSource.query(`
                SELECT 
                    l.code as head_code,
                    h.head_name,
                    l.narration as description,
                    CAST(l.trans_amt AS numeric) as amount,
                    l.trans_type
                FROM ledger l
                LEFT JOIN head_master h ON l.code = h.code
                WHERE l.receipt_vchr_no = $1 AND l.trans_date::date = $2::date
                ORDER BY l.trans_no
            `, [voucher.voucher_no, targetDate]);

            // Get member name
            let memberName = '';
            if (voucher.member_no) {
                const memberResult = await this.dataSource.query(`
                    SELECT f_name, m_name, l_name FROM member_master WHERE mbno = $1
                `, [voucher.member_no]);
                if (memberResult[0]) {
                    memberName = `${memberResult[0].f_name || ''} ${memberResult[0].m_name || ''} ${memberResult[0].l_name || ''}`.trim();
                }
            }

            let voucherPayment = 0;
            let voucherReceipt = 0;

            const entries = transactions.map((t: any, index: number) => {
                const amount = parseFloat(t.amount) || 0;
                const isPayment = t.trans_type === 'DR';
                
                if (isPayment) {
                    voucherPayment += amount;
                } else {
                    voucherReceipt += amount;
                }

                return {
                    sno: index + 1,
                    headCode: t.head_code || '',
                    headName: t.head_name || 'Unknown',
                    description: t.description || '',
                    payment: isPayment ? amount : 0,
                    receipt: !isPayment ? amount : 0
                };
            });

            return {
                voucherNo: voucher.voucher_no,
                memberNo: voucher.member_no || '',
                memberName: memberName,
                modeOfPayment: voucher.mode_of_payment || 'Cash',
                narration: transactions[0]?.description || '',
                entries: entries,
                totalPayment: voucherPayment,
                totalReceipt: voucherReceipt
            };
        }));

        // Calculate opening and closing balance
        const openingBalanceResult = await this.dataSource.query(`
            SELECT 
                SUM(CASE WHEN trans_type = 'CR' THEN CAST(trans_amt AS numeric) ELSE 0 END) -
                SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE 0 END) as balance
            FROM ledger
            WHERE trans_date::date < $1::date
        `, [targetDate]);

        const openingBalance = parseFloat(openingBalanceResult[0]?.balance) || 0;
        const totalPayments = voucherDetails.reduce((sum, v) => sum + v.totalPayment, 0);
        const totalReceipts = voucherDetails.reduce((sum, v) => sum + v.totalReceipt, 0);
        const closingBalance = openingBalance + totalReceipts - totalPayments;

        return {
            date: date,
            openingBalance: openingBalance,
            totalPayments: totalPayments,
            totalReceipts: totalReceipts,
            closingBalance: closingBalance,
            vouchers: voucherDetails
        };
    }

    /**
     * Get daily cash book report (head-wise) - Using tblcashbook table
     */
    async getCashBook2Daily(date: string) {
        const targetDate = parseSafeDate(date);

        // Get all entries for the date from tblcashbook
        const entries = await this.dataSource.query(`
            SELECT 
                headcode as head_code,
                headname as head_name,
                COALESCE(rcash, 0) + COALESCE(rtransfer, 0) as receipt,
                COALESCE(pcash, 0) + COALESCE(ptransfer, 0) as payment
            FROM tblcashbook
            WHERE trans_date::date = $1::date
            ORDER BY headcode
        `, [targetDate]);

        // Calculate totals
        const totalReceipts = entries.reduce((sum: number, e: any) => sum + (parseFloat(e.receipt) || 0), 0);
        const totalPayments = entries.reduce((sum: number, e: any) => sum + (parseFloat(e.payment) || 0), 0);

        // Calculate opening balance (sum of all previous transactions)
        const openingBalanceResult = await this.dataSource.query(`
            SELECT 
                SUM(COALESCE(rcash, 0) + COALESCE(rtransfer, 0)) -
                SUM(COALESCE(pcash, 0) + COALESCE(ptransfer, 0)) as balance
            FROM tblcashbook
            WHERE trans_date::date < $1::date
        `, [targetDate]);

        const openingBalance = parseFloat(openingBalanceResult[0]?.balance) || 0;
        const closingBalance = openingBalance + totalReceipts - totalPayments;

        return {
            date: date,
            openingBalance: openingBalance,
            totalReceipts: totalReceipts,
            totalPayments: totalPayments,
            closingBalance: closingBalance,
            entries: entries.map((e: any) => ({
                headCode: e.head_code || '',
                headName: e.head_name || 'Unknown',
                receipt: parseFloat(e.receipt) || 0,
                payment: parseFloat(e.payment) || 0,
            }))
        };
    }

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
            `SELECT head_name FROM headmaster WHERE code = $1`,
            [head_code]
        );
        const headName = headResult[0]?.head_name || 'Unknown Head';

        // Get total count
        const countRes = await this.dataSource.query(`
            SELECT COUNT(*) FROM ledger WHERE code = $1 AND trans_date >= $2 AND trans_date <= $3
        `, [head_code, parseSafeDate(from_date), parseSafeDate(to_date)]);
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

        const params: any[] = [head_code, parseSafeDate(from_date), parseSafeDate(to_date)];
        if (limit !== undefined) {
            query += ` LIMIT $${params.length + 1}`;
            params.push(limit);
        }
        if (offset !== undefined) {
            query += ` OFFSET $${params.length + 1}`;
            params.push(offset);
        }

        const transactions = await this.dataSource.query(query, params);

        // Opening balance = net DR-CR for this head before from_date
        const obResult = await this.dataSource.query(`
            SELECT
                COALESCE(SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE 0 END), 0) -
                COALESCE(SUM(CASE WHEN trans_type = 'CR' THEN CAST(trans_amt AS numeric) ELSE 0 END), 0) as balance
            FROM ledger
            WHERE code = $1 AND trans_date < $2
        `, [head_code, parseSafeDate(from_date)]);
        let runningBalance = parseFloat(obResult[0]?.balance || '0');

        // For paginated pages, add the balance of rows skipped by offset
        if (offset && offset > 0) {
            const preOffsetResult = await this.dataSource.query(`
                SELECT
                    COALESCE(SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE 0 END), 0) -
                    COALESCE(SUM(CASE WHEN trans_type = 'CR' THEN CAST(trans_amt AS numeric) ELSE 0 END), 0) as balance
                FROM (
                    SELECT trans_type, trans_amt FROM ledger
                    WHERE code = $1 AND trans_date >= $2 AND trans_date <= $3
                    ORDER BY trans_date ASC, trans_no ASC
                    LIMIT $4
                ) pre
            `, [head_code, parseSafeDate(from_date), parseSafeDate(to_date), offset]);
            runningBalance += parseFloat(preOffsetResult[0]?.balance || '0');
        }

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
            `SELECT head_name FROM headmaster WHERE code = $1`,
            [bank_head_code]
        );
        const bankName = bankResult[0]?.head_name || 'Unknown Bank';

        // Get total count
        const countRes = await this.dataSource.query(`
            SELECT COUNT(*) FROM ledger WHERE code = $1 AND trans_date >= $2 AND trans_date <= $3
        `, [bank_head_code, parseSafeDate(from_date), parseSafeDate(to_date)]);
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

        const params: any[] = [bank_head_code, parseSafeDate(from_date), parseSafeDate(to_date)];
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
      SELECT code, head_name FROM headmaster ORDER BY head_name ASC
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
      SELECT code, head_name FROM headmaster 
      WHERE UPPER(head_name) LIKE '%BANK%' OR UPPER(head_name) LIKE '%ACCOUNT%'
      ORDER BY head_name ASC
    `);

        return banks.map((b: any) => ({
            code: b.code,
            name: b.head_name
        }));
    }
}
