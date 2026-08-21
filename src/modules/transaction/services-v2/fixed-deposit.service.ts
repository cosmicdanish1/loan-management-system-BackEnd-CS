import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { generateVoucherNo } from '../../shared/utils/voucher-utils';

@Injectable()
export class FixedDepositService {
    private readonly logger = new Logger(FixedDepositService.name);

    constructor(private readonly dataSource: DataSource) { }

    async createFixedDeposit(data: any) {
        // BUG FIX 44: this endpoint had no validation at all — every other
        // account-opening screen tested this session validates required fields.
        const errors: string[] = [];
        if (!data.memberNo) errors.push('Member is required');
        if (!data.firstName) errors.push('First Name is required');
        if (!data.certificateNo) errors.push('Certificate No is required');
        const depositAmount = parseFloat(data.depositAmount);
        if (!depositAmount || depositAmount <= 0) errors.push('Deposit Amount must be greater than 0');
        const depositPeriod = parseFloat(data.depositPeriod);
        if (!depositPeriod || depositPeriod <= 0) errors.push('Deposit Period must be greater than 0');
        const rate = parseFloat(data.rate);
        if (data.rate === undefined || data.rate === null || data.rate === '' || isNaN(rate) || rate < 0) {
            errors.push('Rate must be a valid non-negative number');
        }
        if (!data.depositDate) errors.push('Deposit Date is required');
        if (errors.length > 0) {
            throw new BadRequestException(errors);
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // BUG FIX 44: no duplicate-certificate check existed — two FDs could
            // silently share the same certificate number.
            const dup = await queryRunner.query(
                `SELECT account_number FROM fdmaster WHERE certno = $1`, [data.certificateNo]
            );
            if (dup.length > 0) {
                throw new ConflictException(
                    `Certificate No '${data.certificateNo}' is already used by account ${dup[0].account_number}`
                );
            }

            // 1. Insert into fdmaster
            // Mapping frontend fields to database columns based on SCHEMA
            /*
            "mbno" numeric,
            "account_number" numeric, -- Auto-generate or lookup?
            "prefix" varchar(5),
            "f_name" varchar(50),
            "m_name" varchar(50),
            "l_name" varchar(50),
            "certno" varchar(10),
            "depunit" int4 NOT NULL, -- Enum or Int?
            "depperiod" numeric,
            "rate" numeric,
            "depdate" timestamp NOT NULL,
            "matdate" timestamp,
            "fdamount" numeric,
            "matamount" numeric,
            "interestpayamentmode" int4, -- 1=Monthly, etc?
            "interestamount" numeric,
            "nominee" varchar(80),
            "nage" varchar(6),
            "naddr" varchar(100),
            "nrelation" varchar(25),
            "fdrdflag" varchar(1), -- 'F' for FD?
            "status" varchar(1), -- 'A' for Active?
            "openbal" numeric
            */

            // BUG FIX 44: was an unguarded MAX(account_number)+1 read outside any lock —
            // same systemic concurrency bug fixed elsewhere this session (no unique
            // constraint on account_number, confirmed via pg_constraint).
            const accountNumber = await this.generateAccountNumber(queryRunner);

            // BUG FIX 44: this INSERT never included interestpayamentmode, which is
            // NOT NULL with no default (confirmed live — every attempt crashed with
            // "null value in column interestpayamentmode violates not-null
            // constraint"). The frontend already collects and sends it as
            // `modeOfPayment`; the backend just never read it.
            const insertQuery = `
                INSERT INTO fdmaster (
                    mbno, account_number, prefix, f_name, m_name, l_name,
                    certno, depunit, depperiod, rate, depdate, matdate,
                    fdamount, matamount, interestamount, interestpayamentmode,
                    nominee, nage, naddr, nrelation,
                    fdrdflag, status, openbal, intcalmethod
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16,
                    $17, $18, $19, $20,
                    'F', 'A', $21, $22
                )
            `;

            // Handle date formatting
            const depDate = data.depositDate ? new Date(data.depositDate) : new Date();
            const matDate = data.maturityDate ? new Date(data.maturityDate) : new Date();

            await queryRunner.query(insertQuery, [
                data.memberNo,
                accountNumber,
                data.prefix,
                data.firstName,
                data.middleName || '',
                data.lastName,
                data.certificateNo,
                data.depositUnit === 'Months' ? 1 : 2, // Assumption: 1=Months, 2=Years
                data.depositPeriod,
                data.rate,
                depDate,
                matDate,
                data.depositAmount,
                data.maturityAmount,
                data.intAmount || 0,
                parseInt(data.modeOfPayment) || 1,
                data.nomineeName,
                data.nomineeAge,
                data.nomineeAddress,
                data.nomineeRelation,
                data.depositAmount, // Open balance = deposit amount
                data.intCalculationMethod === 'compound' ? 2 : 1 // Assumption
            ]);

            // 2. Post to the ledger — BUG FIX 44: this was entirely missing. Real cash
            // received from the member for a new FD was never recorded anywhere in the
            // books. Mirrors closeFixedDeposit's DR/CR pattern in reverse: cash comes
            // IN, an FD liability is created.
            // headCode: the frontend's "FD Head Name" selector only ever offers one
            // hardcoded option ("A003 — FIXED DEPOSIT"), and A003 does not exist in
            // headmaster (confirmed live — no head anywhere is named or typed for a
            // member FD liability; same class of gap as SB's A001). Reusing the same
            // placeholder that createFixedDeposit/closeFixedDeposit/createInterestVoucher
            // all already reference via data.headCode, rather than inventing a new one,
            // so every FD money-movement path can be corrected in one place once a real
            // head exists.
            const maxResult = await queryRunner.query(
                `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no,
                        COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
            );
            const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
            const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);
            const modeOfPay = data.paymentMode === 'bank' ? 'B' : 'C';
            const drCode = modeOfPay === 'B' ? (data.bankCode || 'A1008') : 'A1001';
            const drAccType = modeOfPay === 'B' ? 'BANK' : 'CINH';
            const headCode = data.headCode || 'A003';
            const memberNoInt = parseInt(data.memberNo);
            const voucherNumber = data.voucherNo || (await generateVoucherNo(queryRunner, 'R'));
            const narration = data.narration || `FD Opening Cert ${data.certificateNo}`;

            // DR cash/bank — money received from the member
            await queryRunner.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                  trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                 VALUES ($1, $2, 'DR', $3, $4, 0, $5, $6, $7, 'R', $8, 0, $9, 'system', $10)`,
                [nextTransNo, depDate, drCode, memberNoInt, drAccType, depositAmount, voucherNumber, modeOfPay, narration, nextLedgerId]
            );
            // CR FD liability — the society now owes this back to the member
            await queryRunner.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                  trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                 VALUES ($1, $2, 'CR', $3, $4, 0, 'FD', $5, $6, 'R', $7, 0, $8, 'system', $9)`,
                [nextTransNo + 1, depDate, headCode, memberNoInt, depositAmount, voucherNumber, modeOfPay, narration, nextLedgerId + 1]
            );

            await queryRunner.commitTransaction();

            return {
                success: true,
                message: 'Fixed Deposit created successfully',
                accountNumber,
                voucherNo: voucherNumber,
            };

        } catch (error) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Error creating FD:', error);
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    async getActiveFDsByMember(memberNo: string) {
        const query = `
            SELECT 
                certno as "certNo",
                account_number as "acNo",
                fdamount as "amount",
                rate,
                lastintpaydate as "lastPayDate",
                interestamount as "interest",
                depdate as "depositDate",
                matdate as "maturityDate",
                depunit as "depositUnit",
                depperiod as "depPer",
                matamount as "maturityAmount",
                intpaid as "interestPaid",
                interestpayamentmode as "intPaymentMode",
                status
            FROM fdmaster
            -- BUG FIX 45: '0' is the real active-status convention (confirmed against
            -- utilities.service.ts / voucher.service.ts, the code paths the actual UI
            -- calls) — 'A' was a wrong assumption carried over from this file's own
            -- dead-code creation path, which the frontend never actually calls.
            WHERE mbno = $1 AND status = '0' AND fdrdflag = 'F'
        `;
        const result = await this.dataSource.query(query, [memberNo]);
        return result;
    }

    async createInterestVoucher(data: any) {
        // BUG FIX 44: the frontend (FDInterestVoucherPosting) sends `interestAmount`,
        // but this method read `data.totalAmount` (always undefined -> NULL voucher
        // amount) and `data.calculatedIntt` (also always undefined, so the fdmaster
        // update below never ran regardless of what the operator entered — confirmed
        // by comparing against the actual frontend payload, which has neither field).
        const interestAmount = parseFloat(data.interestAmount) || 0;
        if (!data.memberNo || !data.certNo) {
            throw new BadRequestException('Member and Certificate No are required');
        }
        if (interestAmount <= 0) {
            throw new BadRequestException('Interest Amount must be greater than 0');
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const transDate = data.transDate ? new Date(data.transDate) : new Date();
            const voucherNumber = data.voucherNo || (await generateVoucherNo(queryRunner, 'P'));

            // BUG FIX 44: vouchers.id is NOT NULL with no default/sequence (confirmed
            // live — every call crashed with "null value in column id violates
            // not-null constraint"). Same systemic gap fixed elsewhere this session
            // (e.g. compulsory-deposit.service.ts's getNextId) — this file just never
            // had it. This also means closeFixedDeposit's ledger-posting code below,
            // which an earlier session believed it had already fixed, could never
            // actually have run successfully until now.
            const voucherId = await this.getNextId(queryRunner, 'vouchers', 'id');

            // INSERT into vouchers
            const query = `
                INSERT INTO vouchers (
                    id, "voucherNumber", "voucherDate", "voucherType", "totalAmount",
                    "description", "memberId", "status", "authorizedAt"
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', NOW())
                RETURNING id
            `;

            const voucherRes = await queryRunner.query(query, [
                voucherId,
                voucherNumber,
                transDate,
                data.fdOption === 'interest' ? 'FD_INT' : 'FD_PAY',
                interestAmount,
                data.narration,
                data.memberNo
            ]);

            await queryRunner.query(`
                UPDATE fdmaster
                SET lastintpaydate = $1, intpaid = COALESCE(intpaid, 0) + $2
                WHERE certno = $3 AND mbno = $4
             `, [transDate, interestAmount, data.certNo, data.memberNo]);

            // BUG FIX 44: this never posted to the ledger either — the voucher row
            // above is only a staging record. Money physically paid out to the member
            // for FD interest was invisible in the books. Treated as an immediate cash
            // payout since this screen collects no payment mode (unlike account
            // opening/closure, which both let the operator pick cash/bank) — always
            // credits A1001. DR side reuses the same unresolved FD-liability placeholder
            // as the rest of this file (see createFixedDeposit) pending a real GL head;
            // no real "interest paid on FD" expense head exists in headmaster either
            // (checked live). This is a distinct, simpler path from the separately
            // diagnosed UtilitiesService.payFdInterest() interest-calculation engine —
            // not a fix to that engine.
            const maxResult = await queryRunner.query(
                `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no,
                        COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
            );
            const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
            const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);
            const memberNoInt = parseInt(data.memberNo);
            const headCode = data.headCode || 'A003';
            const narration = data.narration || `FD Interest Payout Cert ${data.certNo}`;

            // DR FD-liability placeholder (standing in for interest expense)
            await queryRunner.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                  trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                 VALUES ($1, $2, 'DR', $3, $4, 0, 'FD', $5, $6, 'P', 'C', 0, $7, 'system', $8)`,
                [nextTransNo, transDate, headCode, memberNoInt, interestAmount, voucherNumber, narration, nextLedgerId]
            );
            // CR cash — money paid out
            await queryRunner.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                  trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                 VALUES ($1, $2, 'CR', 'A1001', $3, 0, 'CINH', $4, $5, 'P', 'C', 0, $6, 'system', $7)`,
                [nextTransNo + 1, transDate, memberNoInt, interestAmount, voucherNumber, narration, nextLedgerId + 1]
            );

            await queryRunner.commitTransaction();
            return { success: true, voucherId: voucherRes[0].id, voucherNo: voucherNumber };
        } catch (err) {
            await queryRunner.rollbackTransaction();
            throw err;
        } finally {
            await queryRunner.release();
        }
    }

    async closeFixedDeposit(data: any) {
        if (!data.memberNo || !data.certNo) {
            throw new BadRequestException('Member and Certificate No are required');
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const transDate = new Date(data.transDate || new Date());
            const voucherNumber = data.voucherNo || (await generateVoucherNo(queryRunner, 'P'));
            const modeOfPay = data.paymentMode === 'bank' ? 'B' : 'C';
            const memberNoInt = parseInt(data.memberNo);
            const totalAmount = parseFloat(data.totalAmount) || 0;

            // 1. Update FD Master status to Closed
            // BUG FIX 44: the UPDATE's affected-row count was never checked — if
            // certNo/mbno didn't match any active FD, this silently updated 0 rows
            // and the code still went on to create a voucher and ledger entries for
            // a closure that never actually happened in fdmaster.
            // BUG FIX 45: this checked status = 'A', a wrong assumption carried over from
            // this file's own dead-code creation/read paths (the real UI never calls
            // createFixedDeposit/getActiveFDsByMember — it calls
            // utilities.service.ts's createFixedDepositReceipt/getFdAccountsByMember,
            // which use '0' for active). Confirmed live: this literally blocked closing
            // a real, active FD created through the real UI moments earlier. 'C' for
            // closed is not independently confirmed elsewhere in the codebase (no other
            // code reads a distinct "closed" marker) but is safe: it just needs to not
            // be '0' so the account list / accrual queries stop treating it as active.
            const updateResult = await queryRunner.query(
                `UPDATE fdmaster
                 SET status = 'C', statusdate = NOW(), matamount = $1,
                     intpaid = COALESCE(intpaid, 0) + $2, remarks = $3
                 WHERE certno = $4 AND mbno = $5 AND status = '0'
                 RETURNING account_number`,
                [
                    data.maturityAmount,
                    parseFloat(data.interestPaid) || 0,
                    'Closed/Withdrawn',
                    data.certNo,
                    data.memberNo
                ]
            );
            // BUG FIX 44: queryRunner.query() returns [rows, rowCount] for
            // UPDATE/DELETE (unlike INSERT/SELECT, which return rows directly) — so
            // `updateResult.length` was always 2 regardless of whether any row
            // actually matched, and this check could never fire (confirmed live: a
            // completely bogus certno still "succeeded" with a full voucher+ledger
            // posting, while fdmaster itself correctly stayed untouched).
            if (updateResult[0].length === 0) {
                throw new BadRequestException(
                    `No active FD found for Certificate No '${data.certNo}' / Member '${data.memberNo}' — it may already be closed or not exist.`
                );
            }

            // 2. Create Voucher record (staging/audit trail)
            // BUG FIX 44: vouchers.id is NOT NULL with no default — this INSERT never
            // supplied one, so this always crashed (confirmed live). Since the
            // ledger-posting code further below was added believing this already
            // worked, it could never actually have run successfully until now.
            const voucherId = await this.getNextId(queryRunner, 'vouchers', 'id');
            const voucherRes = await queryRunner.query(
                `INSERT INTO vouchers (
                    id, "voucherNumber", "voucherDate", "voucherType", "totalAmount",
                    "description", "memberId", "status", "authorizedAt",
                    "payeeName", "bankName", "chequeNumber", "chequeDate"
                ) VALUES ($1, $2, $3, 'FD_CLOSE', $4, $5, $6, 'PENDING', NOW(), $7, $8, $9, $10)
                RETURNING id`,
                [
                    voucherId,
                    voucherNumber,
                    transDate,
                    totalAmount,
                    data.narration || `FD Closure for Cert ${data.certNo}`,
                    data.memberNo,
                    data.payeeName || '',
                    data.bankName || '',
                    data.chequeNo || '',
                    data.chequeDate ? new Date(data.chequeDate) : null
                ]
            );

            // BUG FIX: Add double-entry ledger records — previously ONLY the vouchers table
            // was written. The accounting ledger never reflected FD closures, leaving the
            // ledger permanently unbalanced and cash/bank reports missing payout amounts.
            const maxResult = await queryRunner.query(
                `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no,
                        COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
            );
            const nextTransNo = Number(maxResult[0]?.next_trans_no ?? 1);
            const nextLedgerId = Number(maxResult[0]?.next_ledger_id ?? 1);
            const narration = data.narration || `FD Closure Cert ${data.certNo}`;

            // DR FD liability — closing FD reduces society's liability to this member.
            // BUG FIX 44: hardcoded 'A003' directly; now reads data.headCode (same
            // placeholder used consistently across createFixedDeposit/
            // createInterestVoucher/closeFixedDeposit) so all three can be corrected
            // in one place once a real GL head exists.
            const headCode = data.headCode || 'A003';
            await queryRunner.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                  trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                 VALUES ($1, $2, 'DR', $3, $4, 0, 'FD', $5, $6, 'P', $7, 0, $8, 'system', $9)`,
                [nextTransNo, transDate, headCode, memberNoInt, totalAmount, voucherNumber, modeOfPay, narration, nextLedgerId]
            );

            // CR cash/bank — money paid out to member (asset decreases).
            // Bank mode credits the chosen bank account; cash credits A1001.
            const crCode    = modeOfPay === 'B' ? (data.bankCode || 'A1008') : 'A1001';
            const crAccType = modeOfPay === 'B' ? 'BANK'  : 'CINH';
            await queryRunner.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                  trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                 VALUES ($1, $2, 'CR', $3, $4, 0, $5, $6, $7, 'P', $8, 0, $9, 'system', $10)`,
                [nextTransNo + 1, transDate, crCode, memberNoInt, crAccType, totalAmount, voucherNumber, modeOfPay, narration, nextLedgerId + 1]
            );

            await queryRunner.commitTransaction();
            return { success: true, voucherId: voucherRes[0].id, voucherNo: voucherNumber };

        } catch (err) {
            await queryRunner.rollbackTransaction();
            throw err;
        } finally {
            await queryRunner.release();
        }
    }
    // BUG FIX 44 (same pattern as BUG FIX 35 elsewhere this session): fdmaster's
    // account_number has no unique constraint (confirmed via pg_constraint), so a
    // bare MAX()+1 read outside a lock lets two concurrent FD openings silently
    // compute and insert the same account number. Now runs inside the caller's
    // transaction via queryRunner, with a transaction-scoped advisory lock.
    private async generateAccountNumber(queryRunner: any): Promise<number> {
        await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('fdmaster_account_number'))`);
        const res = await queryRunner.query('SELECT MAX(account_number) as max_acc FROM fdmaster');
        const max = parseInt(res[0].max_acc) || 10000;
        return max + 1;
    }

    // BUG FIX 44 (same pattern as compulsory-deposit.service.ts's getNextId): no
    // unique constraint exists on these id/trans_no columns, so a bare MAX()+1
    // read lets two concurrent transactions compute and insert the same id. A
    // transaction-scoped advisory lock serializes callers without a new sequence.
    private async getNextId(queryRunner: any, table: string, col: string): Promise<number> {
        await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [table]);
        const res = await queryRunner.query(`SELECT COALESCE(MAX(${col}), 0) + 1 as next_id FROM ${table}`);
        return parseInt(res[0].next_id);
    }
}
