import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { parseSafeDate } from '../../shared/utils/date-utils';

// Report Head Order (ES-57): configured position first, heads not in the table last, then by code.
const HEAD_ORDER_SQL = (col: string) =>
    `COALESCE((SELECT ho.position FROM report_head_order ho WHERE ho.code = ${col}), 1000000), ${col}`;

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

        // One query for every leg of the day (head and member names joined in), grouped into
        // vouchers in code. It used to run one query per voucher-and-member row plus one per
        // member name, all at once: a busy day (thousands of legs) used up the connection
        // pool and the report failed with "timeout exceeded when trying to connect".
        // headmaster holds the real head names; head_master is only a fallback.
        const legs = await this.dataSource.query(`
            SELECT
                l.receipt_vchr_no AS voucher_no,
                l.mbno AS member_no,
                l.modeofpay AS mode_of_payment,
                l.code AS head_code,
                COALESCE(hm.head_name, h.head_name) AS head_name,
                l.narration AS description,
                CAST(l.trans_amt AS numeric) AS amount,
                l.trans_type,
                TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) AS member_name
            FROM ledger l
            LEFT JOIN headmaster hm ON hm.code = l.code
            LEFT JOIN head_master h ON h.code = l.code
            LEFT JOIN member_master m ON m.mbno = l.mbno
            WHERE l.trans_date::date = $1::date
              AND l.receipt_vchr_no IS NOT NULL
              AND l.receipt_vchr_no != ''
            ORDER BY l.receipt_vchr_no, l.trans_no, l.ledgerid
        `, [targetDate]);

        // A voucher is listed once, even when its legs carry different member numbers (the
        // first real member is used), so it can no longer be listed or counted twice.
        const byVoucher = new Map<string, any>();
        for (const leg of legs) {
            let v = byVoucher.get(leg.voucher_no);
            if (!v) {
                v = { voucherNo: leg.voucher_no, memberNo: '', memberName: '', modeOfPayment: leg.mode_of_payment || 'Cash', narration: leg.description || '', entries: [], totalPayment: 0, totalReceipt: 0 };
                byVoucher.set(leg.voucher_no, v);
            }
            if (!v.memberNo && leg.member_no && String(leg.member_no) !== '0') {
                v.memberNo = String(leg.member_no);
                v.memberName = (leg.member_name || '').trim();
            }
            const amount = parseFloat(leg.amount) || 0;
            const isPayment = leg.trans_type === 'DR';
            if (isPayment) v.totalPayment += amount; else v.totalReceipt += amount;
            v.entries.push({
                sno: v.entries.length + 1,
                headCode: leg.head_code || '',
                headName: leg.head_name || 'Unknown',
                description: leg.description || '',
                payment: isPayment ? amount : 0,
                receipt: !isPayment ? amount : 0,
            });
        }
        const voucherDetails = Array.from(byVoucher.values());

        // Opening, receipts, payments and closing are the real Cash-In-Hand (A1001) position and
        // movement, the same as the Day-Book (1.3). The old opening balance was credits minus
        // debits over the whole ledger, which is not a cash position, and credit always equalled
        // debit because every voucher balances.
        const openingResult = await this.dataSource.query(`
            SELECT
                SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE 0 END) -
                SUM(CASE WHEN trans_type = 'CR' THEN CAST(trans_amt AS numeric) ELSE 0 END) AS balance
            FROM ledger
            WHERE trans_date::date < $1::date AND code = 'A1001'
        `, [targetDate]);
        const dayResult = await this.dataSource.query(`
            SELECT
                SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE 0 END) AS cash_in,
                SUM(CASE WHEN trans_type = 'CR' THEN CAST(trans_amt AS numeric) ELSE 0 END) AS cash_out
            FROM ledger
            WHERE trans_date::date = $1::date AND code = 'A1001'
        `, [targetDate]);

        const openingBalance = parseFloat(openingResult[0]?.balance) || 0;
        const totalReceipts = parseFloat(dayResult[0]?.cash_in) || 0;
        const totalPayments = parseFloat(dayResult[0]?.cash_out) || 0;
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

        // The legacy report is one aggregated row per head with four separate
        // cash/transfer columns.
        const entries = await this.dataSource.query(`
            SELECT
                headcode as head_code,
                MAX(headname) as head_name,
                SUM(COALESCE(rcash, 0)) as receipt_cash,
                SUM(COALESCE(rtransfer, 0)) as receipt_transfer,
                SUM(COALESCE(pcash, 0)) as payment_cash,
                SUM(COALESCE(ptransfer, 0)) as payment_transfer
            FROM tblcashbook
            WHERE trans_date::date = $1::date
            GROUP BY headcode
            ORDER BY ${HEAD_ORDER_SQL('headcode')}
        `, [targetDate]);

        const totalReceiptsCash = entries.reduce((sum: number, e: any) => sum + (parseFloat(e.receipt_cash) || 0), 0);
        const totalReceiptsTransfer = entries.reduce((sum: number, e: any) => sum + (parseFloat(e.receipt_transfer) || 0), 0);
        const totalPaymentsCash = entries.reduce((sum: number, e: any) => sum + (parseFloat(e.payment_cash) || 0), 0);
        const totalPaymentsTransfer = entries.reduce((sum: number, e: any) => sum + (parseFloat(e.payment_transfer) || 0), 0);
        const totalReceipts = totalReceiptsCash + totalReceiptsTransfer;
        const totalPayments = totalPaymentsCash + totalPaymentsTransfer;

        // Keep cash and transfer opening balances separate. tblcashbook has no
        // distinct clearing column, so clearing remains explicitly zero.
        const openingBalanceResult = await this.dataSource.query(`
            SELECT
                SUM(COALESCE(rcash, 0)) - SUM(COALESCE(pcash, 0)) as cash_balance,
                SUM(COALESCE(rtransfer, 0)) - SUM(COALESCE(ptransfer, 0)) as transfer_balance
            FROM tblcashbook
            WHERE trans_date::date < $1::date
        `, [targetDate]);

        const openingCashInHand = parseFloat(openingBalanceResult[0]?.cash_balance) || 0;
        const openingTransferBalance = parseFloat(openingBalanceResult[0]?.transfer_balance) || 0;
        const openingClearingBalance = 0;
        const openingBalance = openingCashInHand + openingTransferBalance + openingClearingBalance;
        const closingBalance = openingBalance + totalReceipts - totalPayments;
        const closingCashInHand = openingCashInHand + totalReceiptsCash - totalPaymentsCash;
        const closingTransferBalance = openingTransferBalance + totalReceiptsTransfer - totalPaymentsTransfer;

        return {
            date: date,
            openingBalance: openingBalance,
            totalReceipts: totalReceipts,
            totalPayments: totalPayments,
            closingBalance: closingBalance,
            totalReceiptsCash,
            totalReceiptsTransfer,
            totalPaymentsCash,
            totalPaymentsTransfer,
            openingCashInHand,
            openingTransferBalance,
            openingClearingBalance,
            closingCashInHand,
            closingTransferBalance,
            closingClearingBalance: openingClearingBalance,
            entries: entries.map((e: any) => ({
                headCode: e.head_code || '',
                headName: e.head_name || 'Unknown',
                receiptCash: parseFloat(e.receipt_cash) || 0,
                receiptTransfer: parseFloat(e.receipt_transfer) || 0,
                paymentCash: parseFloat(e.payment_cash) || 0,
                paymentTransfer: parseFloat(e.payment_transfer) || 0,
                receipt: (parseFloat(e.receipt_cash) || 0) + (parseFloat(e.receipt_transfer) || 0),
                payment: (parseFloat(e.payment_cash) || 0) + (parseFloat(e.payment_transfer) || 0),
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
        if (monthIndex === undefined) throw new Error(`Invalid month '${month}'`);
        // Plain calendar dates: toISOString() on a local midnight shifts the day back on an IST server.
        const lastDay = new Date(year, monthIndex + 1, 0).getDate();
        const startStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;
        const endStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

        // Get total count (using subquery to count groups)
        const countRes = await this.dataSource.query(`
            SELECT COUNT(DISTINCT headcode) as count 
            FROM tblcashbook 
            WHERE trans_date::date >= $1::date AND trans_date::date <= $2::date
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
        AND trans_date::date >= $1::date
        AND trans_date::date <= $2::date
      GROUP BY headcode
      ORDER BY ${HEAD_ORDER_SQL('headcode')}
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

        // Same basis as the daily Cash-Book (1.2): cash + transfer movement in tblcashbook before the month.
        const [ob] = await this.dataSource.query(`
            SELECT COALESCE(SUM(COALESCE(rcash, 0) + COALESCE(rtransfer, 0) - COALESCE(pcash, 0) - COALESCE(ptransfer, 0)), 0) AS balance
            FROM tblcashbook WHERE trans_date::date < $1::date
        `, [startStr]);
        const openingBalance = parseFloat(ob?.balance) || 0;
        const monthReceipt = result.reduce((t: number, r: any) => t + (parseFloat(r.receipt) || 0), 0);
        const monthPayment = result.reduce((t: number, r: any) => t + (parseFloat(r.payment) || 0), 0);

        return {
            metadata: {
                totalCount,
                limit: limit || totalCount,
                offset: offset || 0
            },
            openingBalance,
            closingBalance: openingBalance + monthReceipt - monthPayment,
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
            SELECT COUNT(*) FROM ledger WHERE code = $1 AND trans_date::date >= $2::date AND trans_date::date <= $3::date
        `, [head_code, String(from_date).slice(0, 10), String(to_date).slice(0, 10)]);
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
      WHERE code = $1 AND trans_date::date >= $2::date AND trans_date::date <= $3::date
      ORDER BY trans_date ASC, trans_no ASC
    `;

        const params: any[] = [head_code, String(from_date).slice(0, 10), String(to_date).slice(0, 10)];
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
            WHERE code = $1 AND trans_date::date < $2::date
        `, [head_code, String(from_date).slice(0, 10)]);
        let runningBalance = parseFloat(obResult[0]?.balance || '0');

        // For paginated pages, add the balance of rows skipped by offset
        if (offset && offset > 0) {
            const preOffsetResult = await this.dataSource.query(`
                SELECT
                    COALESCE(SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE 0 END), 0) -
                    COALESCE(SUM(CASE WHEN trans_type = 'CR' THEN CAST(trans_amt AS numeric) ELSE 0 END), 0) as balance
                FROM (
                    SELECT trans_type, trans_amt FROM ledger
                    WHERE code = $1 AND trans_date::date >= $2::date AND trans_date::date <= $3::date
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
            SELECT COUNT(*) FROM ledger WHERE code = $1 AND trans_date::date >= $2::date AND trans_date::date <= $3::date
        `, [bank_head_code, String(from_date).slice(0, 10), String(to_date).slice(0, 10)]);
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
      WHERE code = $1 AND trans_date::date >= $2::date AND trans_date::date <= $3::date
      ORDER BY trans_date ASC, trans_no ASC
    `;

        const params: any[] = [bank_head_code, String(from_date).slice(0, 10), String(to_date).slice(0, 10)];
        if (limit !== undefined) {
            query += ` LIMIT $${params.length + 1}`;
            params.push(limit);
        }
        if (offset !== undefined) {
            query += ` OFFSET $${params.length + 1}`;
            params.push(offset);
        }

        const transactions = await this.dataSource.query(query, params);

        const [bankOb] = await this.dataSource.query(`
            SELECT COALESCE(SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE -CAST(trans_amt AS numeric) END), 0) AS balance
            FROM ledger WHERE code = $1 AND trans_date::date < $2::date
        `, [bank_head_code, String(from_date).slice(0, 10)]);
        const openingBalance = parseFloat(bankOb?.balance) || 0;
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
