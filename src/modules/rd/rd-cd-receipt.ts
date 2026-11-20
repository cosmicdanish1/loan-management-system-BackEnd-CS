import { BadRequestException } from '@nestjs/common';
import { QueryRunner } from 'typeorm';
import { isDebitNormal } from '../shared/utils/balance-direction';
import { lockNextId } from '../shared/utils/ledger-lock';
import { assertPostingDateOpen } from '../shared/utils/posting-date';

/** RD and CD are one deposit: the member's balance lives on this head. */
export const RD_CD_HEAD = 'L1004';
export const RD_CD_CASH_HEAD = 'A1001';
/** The only voucher type used for RD/CD money (transactions.vchr_type / ledger.vchr_type). */
export const CD_VOUCHER_TYPE = 'CD';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface RdCdReceiptInput {
    mbno: string;
    amount: number;
    /** posting date as YYYY-MM-DD */
    date: string;
    voucherNo: string;
    /** short line used on the transaction, ledger and cash-book rows */
    text: string;
    /** the voucher's description */
    description: string;
    /** the voucher's remarks tag (e.g. NEW_MEMBER_CD, RD_CD_COUNTER) */
    remarks: string;
    username: string;
    /** member creation: the balance row may not exist yet, so it is created */
    createBalanceIfMissing?: boolean;
}

/**
 * ES-508 / ES-573: the ONE way cash received on the RD/CD deposit is booked, whichever window receives it (counter
 * payment, new member's starting amount). It runs on the caller's open transaction and writes, together:
 * a CD voucher, the transaction rows, both general-ledger legs (CR RD/CD L1004, DR cash A1001), the cash-book line
 * (with voucher number and user) and the member's RD/CD balance. The caller owns commit / rollback.
 */
export async function postRdCdReceipt(qr: QueryRunner, p: RdCdReceiptInput): Promise<{ newBalance: number }> {
    const amount = round2(Number(p.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('The RD/CD amount must be greater than zero.');
    await assertPostingDateOpen(qr, p.date); // ES-458

    // the member's one RD/CD balance
    const raw = await qr.query(
        `UPDATE member_balances SET compulsory_deposit = COALESCE(compulsory_deposit, 0) + $1
          WHERE mbno::numeric = $2::numeric RETURNING compulsory_deposit::float AS balance`,
        [amount, p.mbno],
    );
    // TypeORM returns an UPDATE ... RETURNING as [rows, count]; accept both shapes
    let rows: any[] = Array.isArray(raw[0]) ? raw[0] : raw;
    let newBalance: number;
    if (rows.length === 0) {
        if (!p.createBalanceIfMissing) throw new BadRequestException(`Member ${p.mbno} has no balance record, so the payment cannot be posted.`);
        await qr.query(`INSERT INTO member_balances (mbno, compulsory_deposit) VALUES ($1, $2)`, [p.mbno, amount]);
        newBalance = amount;
    } else {
        newBalance = round2(Number(rows[0].balance));
    }

    // voucher (type CD only)
    await lockNextId(qr, 'vouchers', 'id');
    const vid = Number((await qr.query(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM vouchers`))[0].n);
    await qr.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", "payeeName", status, remarks, "createdAt")
         VALUES ($1, $2, $3::date, 'RECEIPT', $4, $5, $6, '', 'POSTED', $7, NOW())`,
        [vid, p.voucherNo, p.date, amount, p.description.slice(0, 250), p.mbno, p.remarks],
    );

    // transactions: credit RD/CD, debit cash
    await lockNextId(qr, 'transactions', 'trans_no');
    let tNo = Number((await qr.query(`SELECT COALESCE(MAX(trans_no), 0) + 1 AS n FROM transactions`))[0].n);
    for (const [type, code, accType] of [['R', RD_CD_HEAD, 'CD'], ['DR', RD_CD_CASH_HEAD, 'CINH']] as Array<[string, string, string]>) {
        await qr.query(
            `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay,
                                       pass_flag, cashier_flag, narration, code, username, acc_type, cheq_amt)
             VALUES ($1, $2, $3::date, $4, $5, $6, $7, 'C', 'Y', 'Y', $8, $9, $10, $11, 0)`,
            [tNo++, type, p.date, p.mbno, amount, p.voucherNo, CD_VOUCHER_TYPE, p.text, code, p.username, accType],
        );
    }

    // general ledger: the RD/CD head goes up (credit), cash goes up (debit)
    await lockNextId(qr, 'ledger', 'ledgerid');
    let ledgerId = Number((await qr.query(`SELECT COALESCE(MAX(ledgerid), 0) + 1 AS n FROM ledger`))[0].n);
    let lTrans = Number((await qr.query(`SELECT COALESCE(MAX(trans_no), 0) + 1 AS n FROM ledger`))[0].n);
    const dirFor = async (code: string) => {
        const r = await qr.query(`SELECT pflag FROM headmaster WHERE TRIM(code) = $1`, [code]);
        return isDebitNormal(r[0]?.pflag) ? 'DR' : 'CR';
    };
    const legs: Array<[string, string, string, number]> = [
        [RD_CD_HEAD, await dirFor(RD_CD_HEAD), 'CD', newBalance],
        [RD_CD_CASH_HEAD, await dirFor(RD_CD_CASH_HEAD), 'CINH', 0],
    ];
    for (const [code, dir, accType, plBal] of legs) {
        await qr.query(
            `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type,
                                 modeofpay, pl_balance, narration, username, ledgerid)
             VALUES ($1, $2::date, $3, $4, $5, 0, $6, $7, $8, $9, 'C', $10, $11, $12, $13)`,
            [lTrans++, p.date, dir, code, p.mbno, accType, amount, p.voucherNo, CD_VOUCHER_TYPE, plBal, p.text, p.username, ledgerId++],
        );
    }

    // cash book: cash received on the RD/CD head
    await qr.query(
        `INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date, voucher_no, username)
         VALUES ($1, $2, $3, 0, 0, 0, $4::date, $5, $6)`,
        [RD_CD_HEAD, p.text, amount, p.date, p.voucherNo, p.username],
    );

    return { newBalance };
}

export interface RdCdPaymentInput {
    mbno: string;
    amount: number;
    /** posting date as YYYY-MM-DD */
    date: string;
    voucherNo: string;
    /** the member's RD/CD balance AFTER the payment (already lowered by the caller) */
    newBalance: number;
    text: string;
    description: string;
    remarks: string;
    username: string;
}

/**
 * ES-579: the cash PAID OUT of the RD/CD deposit (RD/CD Withdrawal), the mirror of postRdCdReceipt. Runs on the caller's
 * open transaction and writes a CD payment voucher, the transaction rows, both general-ledger legs (DR RD/CD L1004 - the
 * liability goes down; CR cash A1001) and the cash-book payment line. The member's balance is lowered by the caller
 * (recordWithdrawal), not here, so it can be done under the member lock together with the minimum-balance checks.
 */
export async function postRdCdPayment(qr: QueryRunner, p: RdCdPaymentInput): Promise<void> {
    const amount = round2(Number(p.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('The RD/CD amount must be greater than zero.');
    await assertPostingDateOpen(qr, p.date); // ES-458

    // voucher (type CD only)
    await lockNextId(qr, 'vouchers', 'id');
    const vid = Number((await qr.query(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM vouchers`))[0].n);
    await qr.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", "payeeName", status, remarks, "createdAt")
         VALUES ($1, $2, $3::date, 'PAYMENT', $4, $5, $6, '', 'POSTED', $7, NOW())`,
        [vid, p.voucherNo, p.date, amount, p.description.slice(0, 250), p.mbno, p.remarks],
    );

    // transactions: debit RD/CD (money out to the member), credit cash
    await lockNextId(qr, 'transactions', 'trans_no');
    let tNo = Number((await qr.query(`SELECT COALESCE(MAX(trans_no), 0) + 1 AS n FROM transactions`))[0].n);
    for (const [type, code, accType] of [['DR', RD_CD_HEAD, 'CD'], ['CR', RD_CD_CASH_HEAD, 'CINH']] as Array<[string, string, string]>) {
        await qr.query(
            `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay,
                                       pass_flag, cashier_flag, narration, code, username, acc_type, cheq_amt)
             VALUES ($1, $2, $3::date, $4, $5, $6, $7, 'C', 'Y', 'Y', $8, $9, $10, $11, 0)`,
            [tNo++, type, p.date, p.mbno, amount, p.voucherNo, CD_VOUCHER_TYPE, p.text, code, p.username, accType],
        );
    }

    // general ledger: the RD/CD head goes DOWN, cash goes DOWN (direction = the opposite of "increase")
    await lockNextId(qr, 'ledger', 'ledgerid');
    let ledgerId = Number((await qr.query(`SELECT COALESCE(MAX(ledgerid), 0) + 1 AS n FROM ledger`))[0].n);
    let lTrans = Number((await qr.query(`SELECT COALESCE(MAX(trans_no), 0) + 1 AS n FROM ledger`))[0].n);
    const decreaseDir = async (code: string) => {
        const r = await qr.query(`SELECT pflag FROM headmaster WHERE TRIM(code) = $1`, [code]);
        return isDebitNormal(r[0]?.pflag) ? 'CR' : 'DR';
    };
    const legs: Array<[string, string, string, number]> = [
        [RD_CD_HEAD, await decreaseDir(RD_CD_HEAD), 'CD', round2(Number(p.newBalance) || 0)],
        [RD_CD_CASH_HEAD, await decreaseDir(RD_CD_CASH_HEAD), 'CINH', 0],
    ];
    for (const [code, dir, accType, plBal] of legs) {
        await qr.query(
            `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type,
                                 modeofpay, pl_balance, narration, username, ledgerid)
             VALUES ($1, $2::date, $3, $4, $5, 0, $6, $7, $8, $9, 'C', $10, $11, $12, $13)`,
            [lTrans++, p.date, dir, code, p.mbno, accType, amount, p.voucherNo, CD_VOUCHER_TYPE, plBal, p.text, p.username, ledgerId++],
        );
    }

    // cash book: cash paid out on the RD/CD head
    await qr.query(
        `INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date, voucher_no, username)
         VALUES ($1, $2, 0, 0, $3, 0, $4::date, $5, $6)`,
        [RD_CD_HEAD, p.text, amount, p.date, p.voucherNo, p.username],
    );
}

/** The expense head the legacy debited for the yearly RD/CD interest (headmaster: E1026 "INTT ON COMPULSORY DEPOSIT"). */
export const RD_CD_INTEREST_HEAD = 'E1026';

export interface RdCdInterestInput {
    mbno: string;
    amount: number;
    /** posting date as YYYY-MM-DD (the legacy dated it the last days of March) */
    date: string;
    voucherNo: string;
    text: string;
    username: string;
}

/**
 * ES-121 / stage 6: the yearly interest on a member's RD/CD, posted exactly as the legacy did (verified in the legacy MS SQL
 * ledger, e.g. voucher J30361 of 29-Mar-2025): a journal with TWO ledger rows, both carrying the member number and
 * the same voucher: DR E1026 (account type OTH, mode J) and CR L1004 (account type CD, mode J). Nothing goes to A1002 or
 * any loan, cash or payable head. The member's stored RD/CD balance rises by the same amount (created if the row is missing).
 * The amount itself is worked out by the RD/CD engine (RdFinancialYearClosingService), never here. Runs on the caller's
 * transaction; the caller owns commit / rollback.
 */
export async function postRdCdInterest(qr: QueryRunner, p: RdCdInterestInput): Promise<{ newBalance: number }> {
    const amount = round2(Number(p.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('The RD/CD interest amount must be greater than zero.');
    await assertPostingDateOpen(qr, p.date); // ES-458
    const head = await qr.query(`SELECT 1 FROM headmaster WHERE TRIM(code) = $1 LIMIT 1`, [RD_CD_INTEREST_HEAD]);
    if (!head || head.length === 0) {
        throw new BadRequestException(`The interest head ${RD_CD_INTEREST_HEAD} (INTT ON COMPULSORY DEPOSIT) does not exist in the chart of accounts.`);
    }

    // the member's one RD/CD balance
    const raw = await qr.query(
        `UPDATE member_balances SET compulsory_deposit = COALESCE(compulsory_deposit, 0) + $1
          WHERE mbno::numeric = $2::numeric RETURNING compulsory_deposit::float AS balance`,
        [amount, p.mbno],
    );
    const rows: any[] = Array.isArray(raw[0]) ? raw[0] : raw;
    let newBalance: number;
    if (rows.length === 0) {
        await qr.query(`INSERT INTO member_balances (mbno, compulsory_deposit) VALUES ($1, $2)`, [p.mbno, amount]);
        newBalance = amount;
    } else {
        newBalance = round2(Number(rows[0].balance));
    }

    // journal voucher
    await lockNextId(qr, 'vouchers', 'id');
    const vid = Number((await qr.query(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM vouchers`))[0].n);
    await qr.query(
        `INSERT INTO vouchers (id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", description, "memberId", "payeeName", status, remarks, "createdAt")
         VALUES ($1, $2, $3::date, 'JOURNAL', $4, $5, $6, '', 'POSTED', 'RD_CD_INTEREST', NOW())`,
        [vid, p.voucherNo, p.date, amount, p.text.slice(0, 250), p.mbno],
    );

    // transactions: debit the interest head, credit RD/CD
    await lockNextId(qr, 'transactions', 'trans_no');
    let tNo = Number((await qr.query(`SELECT COALESCE(MAX(trans_no), 0) + 1 AS n FROM transactions`))[0].n);
    for (const [type, code, accType] of [['DR', RD_CD_INTEREST_HEAD, 'OTH'], ['CR', RD_CD_HEAD, 'CD']] as Array<[string, string, string]>) {
        await qr.query(
            `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay,
                                       pass_flag, cashier_flag, narration, code, username, acc_type, cheq_amt)
             VALUES ($1, $2, $3::date, $4, $5, $6, $7, 'J', 'Y', 'Y', $8, $9, $10, $11, 0)`,
            [tNo++, type, p.date, p.mbno, amount, p.voucherNo, CD_VOUCHER_TYPE, p.text, code, p.username, accType],
        );
    }

    // general ledger, the legacy shape: DR E1026 (OTH) and CR L1004 (CD), both with the member number, mode J
    await lockNextId(qr, 'ledger', 'ledgerid');
    let ledgerId = Number((await qr.query(`SELECT COALESCE(MAX(ledgerid), 0) + 1 AS n FROM ledger`))[0].n);
    let lTrans = Number((await qr.query(`SELECT COALESCE(MAX(trans_no), 0) + 1 AS n FROM ledger`))[0].n);
    const legs: Array<[string, string, string, number]> = [
        [RD_CD_INTEREST_HEAD, 'DR', 'OTH', amount],
        [RD_CD_HEAD, 'CR', 'CD', newBalance],
    ];
    for (const [code, dir, accType, plBal] of legs) {
        await qr.query(
            `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type,
                                 modeofpay, pl_balance, narration, username, ledgerid)
             VALUES ($1, $2::date, $3, $4, $5, 0, $6, $7, $8, $9, 'J', $10, $11, $12, $13)`,
            [lTrans++, p.date, dir, code, p.mbno, accType, amount, p.voucherNo, CD_VOUCHER_TYPE, plBal, p.text, p.username, ledgerId++],
        );
    }
    return { newBalance };
}
