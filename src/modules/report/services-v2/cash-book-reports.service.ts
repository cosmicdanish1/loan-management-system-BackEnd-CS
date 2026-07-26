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

        const MODE_MAP: Record<string, string> = {
            C: 'Cash', B: 'Bank', J: 'Journal', T: 'Transfer', D: 'Draft', N: 'NEFT', G: 'RTGS',
        };

        // Single query: all ledger entries for the date, with head name and member name joined
        const rows = await this.dataSource.query(`
            SELECT
                l.receipt_vchr_no,
                CAST(l.mbno AS text)                                                AS member_no,
                l.modeofpay,
                l.narration,
                l.trans_no,
                l.code                                                              AS head_code,
                COALESCE(h.head_name, l.code, '')                                  AS head_name,
                CAST(l.trans_amt AS numeric)                                        AS amount,
                l.trans_type,
                TRIM(COALESCE(m.f_name,'')||' '||COALESCE(m.m_name,'')||' '||COALESCE(m.l_name,'')) AS member_name
            FROM ledger l
            LEFT JOIN head_master   h ON h.code = l.code
            LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(l.mbno AS text)
            WHERE l.trans_date::date = $1::date
              AND l.receipt_vchr_no IS NOT NULL
              AND TRIM(l.receipt_vchr_no) != ''
            ORDER BY l.receipt_vchr_no, l.trans_no
        `, [targetDate]);

        // Group rows by voucher in JS (no N+1)
        const voucherMap = new Map<string, any>();
        for (const row of rows) {
            const vno = row.receipt_vchr_no;
            if (!voucherMap.has(vno)) {
                voucherMap.set(vno, {
                    voucherNo: vno,
                    memberNo: row.member_no || '',
                    memberName: '',
                    modeOfPayment: MODE_MAP[(row.modeofpay || '').toUpperCase()] ?? (row.modeofpay || 'Cash'),
                    narration: row.narration || '',
                    entries: [],
                    totalPayment: 0,
                    totalReceipt: 0,
                    _sno: 0,
                });
            }
            const v = voucherMap.get(vno);

            // Pick up member name from first non-empty row
            if (!v.memberName && row.member_name?.trim()) {
                v.memberName = row.member_name.trim();
            }

            // Skip blank head-code rows (cash offset entries)
            if (!row.head_code?.trim()) continue;

            const amount = parseFloat(row.amount) || 0;
            const isPayment = row.trans_type === 'DR';
            if (isPayment) v.totalPayment += amount; else v.totalReceipt += amount;
            v._sno++;
            v.entries.push({
                sno: v._sno,
                headCode: row.head_code || '',
                headName: row.head_name || '',
                description: row.narration || '',
                payment: isPayment ? amount : 0,
                receipt: !isPayment ? amount : 0,
            });
        }

        // Remove internal _sno helper before returning
        const voucherDetails = [...voucherMap.values()].map(({ _sno, ...v }) => v);

        // Opening balance = net of all transactions BEFORE this date
        const openingBalanceResult = await this.dataSource.query(`
            SELECT
                SUM(CASE WHEN trans_type = 'CR' THEN CAST(trans_amt AS numeric) ELSE 0 END) -
                SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE 0 END) AS balance
            FROM ledger
            WHERE trans_date::date < $1::date
        `, [targetDate]);

        const openingBalance = parseFloat(openingBalanceResult[0]?.balance) || 0;
        const totalPayments = voucherDetails.reduce((sum: number, v: any) => sum + v.totalPayment, 0);
        const totalReceipts = voucherDetails.reduce((sum: number, v: any) => sum + v.totalReceipt, 0);
        const closingBalance = openingBalance + totalReceipts - totalPayments;

        return {
            date,
            openingBalance,
            totalPayments,
            totalReceipts,
            closingBalance,
            vouchers: voucherDetails,
        };
    }

    /**
     * Get daily cash book report (head-wise) - Using tblcashbook table
     */
    async getCashBook2Daily(date: string) {
        const targetDate = parseSafeDate(date);

        // Get entries: prefer tblcashbook when it has data; fall back to ledger for dates without.
        // Both sources join accountbalance for proper names.
        const entries = await this.dataSource.query(`
            WITH cb AS (
                SELECT
                    t.headcode AS head_code,
                    COALESCE(
                        ab.acname,
                        REGEXP_REPLACE(t.headname, '\\s*\\[Code:[^\\]]*\\]\\s*', '', 'g'),
                        t.headcode
                    ) AS head_name,
                    COALESCE(t.rcash, 0) + COALESCE(t.rtransfer, 0) AS receipt,
                    COALESCE(t.pcash, 0) + COALESCE(t.ptransfer, 0) AS payment
                FROM tblcashbook t
                LEFT JOIN accountbalance ab ON ab.acno = t.headcode
                WHERE t.trans_date::date = $1::date
                  AND t.headcode IS NOT NULL AND TRIM(t.headcode) != ''
            ),
            cb_count AS (SELECT COUNT(*) AS cnt FROM cb),
            ledger_src AS (
                SELECT DISTINCT ON (ledgerid)
                    ledgerid, code, trans_type,
                    CAST(trans_amt AS numeric) AS amt
                FROM ledger
                WHERE trans_date::date = $1::date
                  AND code IS NOT NULL AND TRIM(code) != ''
                  AND code != 'A1001'
                ORDER BY ledgerid
            ),
            lg AS (
                SELECT
                    ls.code AS head_code,
                    COALESCE(ab.acname, ls.code) AS head_name,
                    SUM(CASE WHEN ls.trans_type = 'CR' THEN ls.amt ELSE 0 END) AS receipt,
                    SUM(CASE WHEN ls.trans_type = 'DR' THEN ls.amt ELSE 0 END) AS payment
                FROM ledger_src ls
                LEFT JOIN accountbalance ab ON ab.acno = ls.code
                GROUP BY ls.code, ab.acname
            )
            SELECT head_code, head_name, receipt, payment
            FROM cb WHERE (SELECT cnt FROM cb_count) > 0
            UNION ALL
            SELECT head_code, head_name, receipt, payment
            FROM lg  WHERE (SELECT cnt FROM cb_count) = 0
              AND (receipt > 0 OR payment > 0)
            ORDER BY head_code
        `, [targetDate]);

        const totalReceipts = entries.reduce((sum: number, e: any) => sum + (parseFloat(e.receipt) || 0), 0);
        const totalPayments = entries.reduce((sum: number, e: any) => sum + (parseFloat(e.payment) || 0), 0);

        // Opening balance: take the most recent daily_gl_history snapshot for A1001 (cash-in-hand)
        // then extend with subsequent ledger CINH entries + tblcashbook dated entries up to the day before.
        const openingResult = await this.dataSource.query(`
            WITH last_gl AS (
                SELECT CAST(balance AS numeric) AS bal, trans_date::date AS gl_date
                FROM daily_gl_history
                WHERE code = 'A1001' AND trans_date::date < $1::date
                ORDER BY trans_date DESC LIMIT 1
            )
            SELECT
                COALESCE((SELECT bal FROM last_gl), 0)
                + COALESCE((
                    SELECT SUM(CASE WHEN t.trans_type='DR' THEN t.amt ELSE -t.amt END)
                    FROM (
                        SELECT DISTINCT ON (ledgerid)
                            ledgerid, trans_type,
                            CAST(trans_amt AS numeric) AS amt,
                            trans_date
                        FROM ledger
                        WHERE code = 'A1001' AND acc_type = 'CINH'
                        ORDER BY ledgerid
                    ) t
                    WHERE t.trans_date::date > COALESCE((SELECT gl_date FROM last_gl), '2000-01-01')
                      AND t.trans_date::date < $1::date
                ), 0)
                + COALESCE((
                    SELECT SUM(COALESCE(rcash,0)+COALESCE(rtransfer,0))
                           - SUM(COALESCE(pcash,0)+COALESCE(ptransfer,0))
                    FROM tblcashbook
                    WHERE trans_date IS NOT NULL
                      AND trans_date::date > COALESCE((SELECT gl_date FROM last_gl), '2000-01-01')
                      AND trans_date::date < $1::date
                ), 0) AS opening_balance
        `, [targetDate]);

        const openingBalance = parseFloat(openingResult[0]?.opening_balance) || 0;
        const closingBalance = openingBalance + totalReceipts - totalPayments;

        return {
            date: date,
            openingBalance,
            totalReceipts,
            totalPayments,
            closingBalance,
            entries: entries.map((e: any) => ({
                headCode: e.head_code || '',
                headName: e.head_name || '',
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
            'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
            'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12
        };

        // Build date strings directly — avoid JS Date toISOString() UTC timezone shift
        const monthNum = monthMap[month.substring(0, 3)] ?? 1;
        const mm = String(monthNum).padStart(2, '0');
        const startStr = `${year}-${mm}-01`;
        // Last day of month via SQL-safe approach
        const lastDay = new Date(year, monthNum, 0).getDate();
        const endStr = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;

        // Count distinct head codes in range (::date cast for safe timestamp comparison)
        const countRes = await this.dataSource.query(`
            SELECT COUNT(DISTINCT headcode) AS count
            FROM tblcashbook
            WHERE trans_date::date >= $1::date
              AND trans_date::date <= $2::date
        `, [startStr, endStr]);
        const totalCount = parseInt(countRes[0].count) || 0;

        // Main query: join accountbalance for proper head names (tblcashbook.headname may have [Code:...] suffixes)
        let query = `
            SELECT
                t.headcode                                                         AS code,
                COALESCE(ab.acname, MAX(t.headname), t.headcode)                  AS "headName",
                SUM(COALESCE(t.rcash, 0) + COALESCE(t.rtransfer, 0))             AS receipt,
                SUM(COALESCE(t.pcash, 0) + COALESCE(t.ptransfer, 0))             AS payment
            FROM tblcashbook t
            LEFT JOIN accountbalance ab ON ab.acno = t.headcode
            WHERE t.trans_date IS NOT NULL
              AND t.trans_date::date >= $1::date
              AND t.trans_date::date <= $2::date
              AND t.headcode IS NOT NULL AND TRIM(t.headcode) != ''
            GROUP BY t.headcode, ab.acname
            ORDER BY t.headcode
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

        // Opening balance: sum of all tblcashbook before the month
        const obRes = await this.dataSource.query(`
            SELECT
                COALESCE(SUM(COALESCE(rcash,0) + COALESCE(rtransfer,0)), 0) -
                COALESCE(SUM(COALESCE(pcash,0) + COALESCE(ptransfer,0)), 0) AS opening_balance
            FROM tblcashbook
            WHERE trans_date IS NOT NULL
              AND trans_date::date < $1::date
        `, [startStr]);
        const openingBalance = parseFloat(obRes[0]?.opening_balance) || 0;

        const data = result.map((item: any, index: number) => ({
            key: ((offset || 0) + index).toString(),
            code: item.code || '',
            headName: item.headName || item.code || 'Unknown Head',
            receipt: parseFloat(item.receipt) || 0,
            payment: parseFloat(item.payment) || 0,
        }));

        const totalReceipt = data.reduce((s: number, r: any) => s + r.receipt, 0);
        const totalPayment = data.reduce((s: number, r: any) => s + r.payment, 0);

        return {
            metadata: { totalCount, limit: limit || totalCount, offset: offset || 0 },
            openingBalance,
            totalReceipt,
            totalPayment,
            closingBalance: openingBalance + totalReceipt - totalPayment,
            data,
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
     * Get list of operational bank current accounts for disbursement/receipts.
     *
     * These are the real ledger heads grouped under parent 'A1007'
     * ("CURRENT ACCOUNT WITH BANK") — e.g. A1008..A1013. This matches the
     * legacy app's Bank dropdown exactly.
     *
     * NOTE: a name LIKE '%BANK%'/'%ACCOUNT%' filter is intentionally NOT used —
     * it wrongly pulls in TERM DEPOSITs (parent A1014), expense heads
     * (E1028 BANK COMMISSION), income (I1003), liabilities (B.N.S.BANK RECOVERY)
     * and template heads. We filter by the current-account parent instead.
     */
    async getBankList() {
        const banks = await this.dataSource.query(`
      SELECT code, head_name FROM headmaster
      WHERE parent_code = 'A1007'
      ORDER BY head_name ASC
    `);

        return banks.map((b: any) => ({
            code: b.code,
            name: b.head_name
        }));
    }
}
