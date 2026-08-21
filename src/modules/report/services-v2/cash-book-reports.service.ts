import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { parseSafeDate } from '../../shared/utils/date-utils';

/**
 * Identifies the cash leg of a voucher — the row representing money actually
 * entering or leaving the drawer, as opposed to the heads explaining what it
 * was for. Posting code stamps these with acc_type CINH (see
 * PassTransactionService and UtilitiesService.saveSavingTransaction); older
 * rows are matched on the cash head code instead.
 *
 * Covers cash in hand *and* bank: tblcashbook has always carried separate
 * rcash/rtransfer and pcash/ptransfer columns, so transfers are part of what
 * this book reports. Both Cash Book windows use this one definition, so the
 * pair cannot show two different balances for the same day — they previously
 * disagreed by roughly ₹2.6 crore, partly because one counted bank and the
 * other did not.
 *
 * CASH_LEG_SQL must express the same rule as isCashLeg(); change them together.
 */
const CASH_ACC_TYPES = new Set(['CINH', 'BANK']);
const CASH_HEAD_CODE = 'A1001';
const CASH_LEG_SQL = `(UPPER(COALESCE(acc_type, '')) IN ('CINH', 'BANK') OR code = '${CASH_HEAD_CODE}')`;

function isCashLeg(row: { acc_type?: string | null; head_code?: string | null }): boolean {
    return CASH_ACC_TYPES.has((row.acc_type || '').trim().toUpperCase())
        || (row.head_code || '').trim() === CASH_HEAD_CODE;
}

/**
 * Cash and bank carried in from before `date`. A debit increases it.
 * Shared so both Cash Book windows open on the same figure.
 */
async function cashOpeningBalance(dataSource: DataSource, targetDate: any): Promise<number> {
    const result = await dataSource.query(`
        SELECT
            SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE 0 END) -
            SUM(CASE WHEN trans_type = 'CR' THEN CAST(trans_amt AS numeric) ELSE 0 END) AS balance
        FROM ledger
        WHERE trans_date::date < $1::date
          AND ${CASH_LEG_SQL}
    `, [targetDate]);
    return parseFloat(result[0]?.balance) || 0;
}

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

        // Single query: all ledger entries for the date, with head name and member name joined.
        //
        // DISTINCT ON (ledgerid) guards against join fan-out. member_master
        // currently holds two members twice over (610033326 and 990042294),
        // so the member join returns each of their ledger rows twice and every
        // amount was counted twice — voucher J33437 reported ₹2,004 of cash
        // against ₹1,002 actually received. One ledger row must contribute
        // once no matter how many rows the lookup tables happen to match.
        const rows = await this.dataSource.query(`
            SELECT * FROM (
                SELECT DISTINCT ON (l.ledgerid)
                    l.ledgerid,
                    l.receipt_vchr_no,
                    CAST(l.mbno AS text)                                                AS member_no,
                    l.modeofpay,
                    l.narration,
                    l.trans_no,
                    l.code                                                              AS head_code,
                    COALESCE(h.head_name, l.code, '')                                  AS head_name,
                    CAST(l.trans_amt AS numeric)                                        AS amount,
                    l.trans_type,
                    l.acc_type,
                    TRIM(COALESCE(m.f_name,'')||' '||COALESCE(m.m_name,'')||' '||COALESCE(m.l_name,'')) AS member_name
                FROM ledger l
                LEFT JOIN headmaster    h ON h.code = l.code
                LEFT JOIN member_master m ON CAST(m.mbno AS text) = CAST(l.mbno AS text)
                WHERE l.trans_date::date = $1::date
                  AND l.receipt_vchr_no IS NOT NULL
                  AND TRIM(l.receipt_vchr_no) != ''
                ORDER BY l.ledgerid
            ) x
            ORDER BY x.receipt_vchr_no, x.trans_no
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

            // A cash book measures movement on the CASH account; the other heads
            // are the analysis of what that cash was for. This used to total every
            // head on both sides of the voucher, and since every voucher balances
            // by construction, receipts always equalled payments and the book could
            // never show any cash movement at all — ₹1.26 crore passed through
            // 10-Jun-2026 and it reported the drawer unchanged.
            if (isCashLeg(row)) {
                // On the cash head, DR means cash came in, CR means cash went out.
                if (row.trans_type === 'DR') v.totalReceipt += amount;
                else v.totalPayment += amount;
                continue; // the cash leg itself is the movement, not a line of analysis
            }

            const isPayment = row.trans_type === 'DR';
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

        // Opening balance used to net every head in the entire ledger — loans,
        // shares, deposits, income and cash together — which for a balanced
        // ledger is meaningless: it returned the same ₹2,42,044 for every date
        // in history. Now it is cash on hand, shared with Cash Book 2.
        const openingBalance = await cashOpeningBalance(this.dataSource, targetDate);
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
     * Get daily cash book report (head-wise).
     *
     * Reads the ledger, the same source as the voucher-wise window, so the two
     * screens describe one day's cash from one set of facts. It used to prefer
     * tblcashbook and fall back to the ledger only for dates tblcashbook did
     * not cover, which made the pair disagree: tblcashbook holds the balancing
     * A1001 contra row as a *receipt*, so a disbursement day totalled equal
     * receipts and payments and reported no cash movement at all. That table is
     * also unusable as a dated source — 7,281 of its 7,310 rows carry no
     * trans_date, and it has no acc_type to tell a cash leg from an analysis
     * head.
     *
     * The cash and bank legs are excluded here on purpose: this window lists
     * what the money was *for*, so payments less receipts across these heads is
     * the day's net cash movement, matching the voucher-wise window's closing
     * balance.
     */
    async getCashBook2Daily(date: string) {
        const targetDate = parseSafeDate(date);

        // modeofpay is stamped per ledger row from the same transaction the analysis
        // head row belongs to ('C' = cash, anything else = bank/cheque/NEFT/RTGS —
        // same binary split daybook.service.ts already uses). Splitting receipt and
        // payment by it here matches the legacy Cash Book's CASH/TRANSFER sub-columns.
        const entries = await this.dataSource.query(`
            WITH ledger_src AS (
                SELECT DISTINCT ON (ledgerid)
                    ledgerid, code, trans_type, modeofpay,
                    CAST(trans_amt AS numeric) AS amt
                FROM ledger
                WHERE trans_date::date = $1::date
                  AND code IS NOT NULL AND TRIM(code) != ''
                  AND NOT ${CASH_LEG_SQL}
                ORDER BY ledgerid
            )
            SELECT
                ls.code AS head_code,
                COALESCE(ab.acname, h.head_name, ls.code) AS head_name,
                SUM(CASE WHEN ls.trans_type = 'CR' AND UPPER(COALESCE(ls.modeofpay, 'C')) = 'C' THEN ls.amt ELSE 0 END) AS receipt_cash,
                SUM(CASE WHEN ls.trans_type = 'CR' AND UPPER(COALESCE(ls.modeofpay, 'C')) != 'C' THEN ls.amt ELSE 0 END) AS receipt_transfer,
                SUM(CASE WHEN ls.trans_type = 'DR' AND UPPER(COALESCE(ls.modeofpay, 'C')) = 'C' THEN ls.amt ELSE 0 END) AS payment_cash,
                SUM(CASE WHEN ls.trans_type = 'DR' AND UPPER(COALESCE(ls.modeofpay, 'C')) != 'C' THEN ls.amt ELSE 0 END) AS payment_transfer
            FROM ledger_src ls
            LEFT JOIN accountbalance ab ON ab.acno = ls.code
            LEFT JOIN headmaster     h  ON h.code  = ls.code
            GROUP BY ls.code, ab.acname, h.head_name
            HAVING SUM(CASE WHEN ls.trans_type = 'CR' THEN ls.amt ELSE 0 END) > 0
                OR SUM(CASE WHEN ls.trans_type = 'DR' THEN ls.amt ELSE 0 END) > 0
            ORDER BY ls.code
        `, [targetDate]);

        const num = (v: any) => parseFloat(v) || 0;
        const totalReceiptsCash = entries.reduce((sum: number, e: any) => sum + num(e.receipt_cash), 0);
        const totalReceiptsTransfer = entries.reduce((sum: number, e: any) => sum + num(e.receipt_transfer), 0);
        const totalPaymentsCash = entries.reduce((sum: number, e: any) => sum + num(e.payment_cash), 0);
        const totalPaymentsTransfer = entries.reduce((sum: number, e: any) => sum + num(e.payment_transfer), 0);
        const totalReceipts = totalReceiptsCash + totalReceiptsTransfer;
        const totalPayments = totalPaymentsCash + totalPaymentsTransfer;

        // Same opening balance as the voucher-wise window. This used to start
        // from a daily_gl_history snapshot and extend it with CINH ledger rows
        // and dated tblcashbook rows, which returned a negative cash position —
        // around minus ₹26 lakh — on days the other window opened ₹2.38 crore
        // positive. A drawer cannot hold negative cash.
        const openingBalance = await cashOpeningBalance(this.dataSource, targetDate);
        const closingBalance = openingBalance + totalReceipts - totalPayments;

        return {
            date: date,
            openingBalance,
            totalReceipts,
            totalPayments,
            totalReceiptsCash,
            totalReceiptsTransfer,
            totalPaymentsCash,
            totalPaymentsTransfer,
            closingBalance,
            entries: entries.map((e: any) => ({
                headCode: e.head_code || '',
                headName: e.head_name || '',
                receiptCash: num(e.receipt_cash),
                receiptTransfer: num(e.receipt_transfer),
                paymentCash: num(e.payment_cash),
                paymentTransfer: num(e.payment_transfer),
                receipt: num(e.receipt_cash) + num(e.receipt_transfer),
                payment: num(e.payment_cash) + num(e.payment_transfer),
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

        // BUG FIX: accountbalance is empty in this database (0 rows, confirmed
        // live) — ab.acname was always NULL, so this fell through to
        // MAX(t.headname), but tblcashbook.headname stores each transaction's own
        // narration text (e.g. "EMERGENCY LOAN [Code: A1047]"), not a real head
        // name, so the report displayed narration instead of a head name.
        // headmaster has 151 real rows (confirmed live) and is the fallback
        // already established for this exact gap elsewhere this session — added
        // ahead of the narration fallback so it's tried first.
        let query = `
            SELECT
                t.headcode                                                         AS code,
                COALESCE(ab.acname, hm.head_name, MAX(t.headname), t.headcode)    AS "headName",
                SUM(COALESCE(t.rcash, 0) + COALESCE(t.rtransfer, 0))             AS receipt,
                SUM(COALESCE(t.pcash, 0) + COALESCE(t.ptransfer, 0))             AS payment
            FROM tblcashbook t
            LEFT JOIN accountbalance ab ON ab.acno = t.headcode
            LEFT JOIN headmaster     hm ON hm.code = t.headcode
            WHERE t.trans_date IS NOT NULL
              AND t.trans_date::date >= $1::date
              AND t.trans_date::date <= $2::date
              AND t.headcode IS NOT NULL AND TRIM(t.headcode) != ''
            GROUP BY t.headcode, ab.acname, hm.head_name
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

        // BUG FIX: openingBalance was hardcoded to 0, ignoring all transactions
        // before from_date — live-confirmed wrong: a bank head with a real ₹8,000
        // prior credit before the filtered range still showed 0 here. Same
        // opening-balance calc getDetailLedger already does correctly, mirrored.
        const obResult = await this.dataSource.query(`
            SELECT
                COALESCE(SUM(CASE WHEN trans_type = 'DR' THEN CAST(trans_amt AS numeric) ELSE 0 END), 0) -
                COALESCE(SUM(CASE WHEN trans_type = 'CR' THEN CAST(trans_amt AS numeric) ELSE 0 END), 0) as balance
            FROM ledger
            WHERE code = $1 AND trans_date < $2
        `, [bank_head_code, parseSafeDate(from_date)]);
        const openingBalance = parseFloat(obResult[0]?.balance || '0');
        let runningBalance = openingBalance;

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
            `, [bank_head_code, parseSafeDate(from_date), parseSafeDate(to_date), offset]);
            runningBalance += parseFloat(preOffsetResult[0]?.balance || '0');
        }

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
