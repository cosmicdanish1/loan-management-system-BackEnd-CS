import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { SequenceGeneratorService } from '../../../shared/services';
import { isDebitNormal } from '../../../shared/utils/balance-direction';
import { lockLedgerIds, lockNextId } from '../../../shared/utils/ledger-lock';
import { assertPostingDateOpen } from '../../../shared/utils/posting-date';
import { interestHeadForLoanType } from '../../loan-interest-heads';
import { LoanRepaymentService, RepaymentPlan } from '../loan-repayment.service';
import { round2 } from '../loan-rb-schedule.util';
import { assertNoPendingVoucher, lockLoanForPendingVoucher } from '../loan-pending-voucher.util';

/**
 * ES-558: Loan Repayment held in Past Transaction.
 *
 * The Loan Repayment window collects the dues of the month(s) now owed. Like every money movement it is raised as a
 * voucher (sourceModule LOAN_REPAYMENT) and posted when it is passed. The split of the amount is FROZEN when the
 * voucher is raised (RepaymentPlan); Pass re-checks that the loan's dues are still the same and replays the rows.
 * A loan can have only one pending voucher (repayment, early closure or re-agreement) at a time.
 */
export const LOAN_REPAYMENT_SOURCE_MODULE = 'LOAN_REPAYMENT';
const VOUCHER_TYPE_CODE = 'LR'; // transactions.vchr_type / ledger.vchr_type (varchar(2))
const BALANCE_TOLERANCE = 0.01;

export interface CreateRepaymentHoldDto {
    mbno: string;
    loancaseno: string;
    loantype?: string;
    amount: number;
    receiptNo?: string;
    narration?: string;
    paymentMode?: 'CASH' | 'BANK';
    bankCode?: string;
    asOfDate?: Date;
}

const num = (v: any, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

@Injectable()
export class LoanRepaymentHoldService {
    private readonly logger = new Logger(LoanRepaymentHoldService.name);
    private tableReady = false;

    constructor(
        private readonly dataSource: DataSource,
        private readonly sequenceGenerator: SequenceGeneratorService,
        private readonly loanRepayment: LoanRepaymentService,
    ) { }

    /** Created at start-up so the one-pending-voucher check (loan-pending-voucher.util) can always see the table. */
    async onModuleInit(): Promise<void> {
        try { await this.ensureTable(); } catch (e: any) { this.logger.warn(`loan_repayment_holds could not be prepared yet: ${e?.message || e}`); }
    }

    async ensureTable(runner: DataSource | QueryRunner = this.dataSource): Promise<void> {
        if (this.tableReady) return;
        await runner.query(`CREATE TABLE IF NOT EXISTS loan_repayment_holds (
            id SERIAL PRIMARY KEY,
            voucher_no VARCHAR(40) NOT NULL UNIQUE,
            mbno VARCHAR(20) NOT NULL,
            loancaseno VARCHAR(40) NOT NULL,
            loantype VARCHAR(10) NOT NULL,
            status VARCHAR(12) NOT NULL DEFAULT 'PENDING',
            pay_mode VARCHAR(4) NOT NULL DEFAULT 'CASH',
            bank_code VARCHAR(20),
            quoted_on DATE NOT NULL,
            amount NUMERIC(14,2) NOT NULL DEFAULT 0,
            receipt_no VARCHAR(60),
            plan JSONB NOT NULL,
            created_by VARCHAR(60),
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            passed_at TIMESTAMP,
            cancelled_at TIMESTAMP
        )`);
        await runner.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_repayment_hold_pending
            ON loan_repayment_holds (mbno, loancaseno, loantype) WHERE status = 'PENDING'`);
        this.tableReady = true;
    }

    private async nextId(runner: QueryRunner, table: string, col: string): Promise<number> {
        await lockNextId(runner, table, col);
        const r = await runner.query(`SELECT COALESCE(MAX(${col}), 0) + 1 AS n FROM ${table}`);
        return parseInt(r[0].n, 10);
    }

    private async increaseDirection(runner: QueryRunner, headCode: string): Promise<'DR' | 'CR'> {
        const rows = await runner.query(`SELECT pflag FROM headmaster WHERE code = $1`, [headCode]);
        return isDebitNormal(rows[0]?.pflag) ? 'DR' : 'CR';
    }

    private async decreaseDirection(runner: QueryRunner, headCode: string): Promise<'DR' | 'CR'> {
        return (await this.increaseDirection(runner, headCode)) === 'DR' ? 'CR' : 'DR';
    }

    /** Loan-account head: same convention as the disbursement and early-closure vouchers (RLN = A1002, every other type = A1047). */
    private principalHead(loantype: string): string {
        return String(loantype || '').toUpperCase() === 'RLN' ? 'A1002' : 'A1047';
    }

    async getByVoucher(runner: QueryRunner | DataSource, voucherNo: string, lock = false) {
        await this.ensureTable(runner);
        const r = await runner.query(`SELECT * FROM loan_repayment_holds WHERE voucher_no = $1 ${lock ? 'FOR UPDATE' : ''}`, [voucherNo]);
        return r[0] || null;
    }

    async getPendingForLoan(mbno: string, loancaseno: string, runner: QueryRunner | DataSource = this.dataSource) {
        await this.ensureTable(runner);
        const r = await runner.query(
            `SELECT id, voucher_no, amount, quoted_on::text AS quoted_on FROM loan_repayment_holds
              WHERE mbno = $1 AND loancaseno = $2 AND status = 'PENDING' LIMIT 1`,
            [String(mbno), String(loancaseno)],
        );
        return r[0] || null;
    }

    // ------------------------------------------------------------------ preview (nothing saved)
    /** How an amount would be applied to the dues now. Saves nothing; the window shows it before the voucher is raised. */
    async preview(dto: CreateRepaymentHoldDto) {
        const mbno = String(dto.mbno || '').trim();
        const caseNo = String(dto.loancaseno || '').trim();
        if (!mbno || !caseNo) throw new BadRequestException('mbno and loan case number are required.');
        const { plan, flag } = await this.loanRepayment.buildRepaymentPlan(null, {
            mbno, loancaseno: caseNo, loantype: dto.loantype, amount: dto.amount, asOfDate: dto.asOfDate,
            receiptNo: dto.receiptNo, narration: dto.narration,
        });
        return { plan, flag: flag ?? undefined };
    }

    // ------------------------------------------------------------------ create (loan window -> Past Transaction)
    async create(dto: CreateRepaymentHoldDto, createdBy: string) {
        await this.ensureTable();
        const mbno = String(dto.mbno || '').trim();
        const caseNo = String(dto.loancaseno || '').trim();
        if (!mbno || !caseNo) throw new BadRequestException('mbno and loan case number are required.');
        const mode: 'CASH' | 'BANK' = dto.paymentMode === 'BANK' ? 'BANK' : 'CASH';
        if (mode === 'BANK' && !dto.bankCode) throw new BadRequestException('Bank mode requires the bank head code (bankCode).');

        const loanRows = await this.dataSource.query(
            `SELECT mbno, loantype, balance FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2 ${dto.loantype ? 'AND loantype = $3' : ''}`,
            dto.loantype ? [caseNo, mbno, dto.loantype] : [caseNo, mbno]);
        if (loanRows.length === 0) throw new NotFoundException(`Loan case ${caseNo} not found for member ${mbno}.`);
        if (loanRows.length > 1) throw new BadRequestException(`Loan case ${caseNo} exists under more than one loan type for member ${mbno}; the loan type is required.`);
        if (num(loanRows[0].balance) <= 0) throw new BadRequestException(`Loan ${caseNo} is already fully repaid.`);
        const loantype = String(loanRows[0].loantype);

        const voucherNo = await this.sequenceGenerator.getNextVoucherNumber();

        const qr = this.dataSource.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
            await lockLoanForPendingVoucher(qr, mbno, caseNo);
            await assertNoPendingVoucher(qr, mbno, caseNo, 'record a repayment'); // one pending voucher per loan
            const asOf = dto.asOfDate && !isNaN(dto.asOfDate.getTime()) ? dto.asOfDate : new Date();
            await assertPostingDateOpen(qr, asOf); // ES-458

            // ES-451: a receipt number that is already on this loan (posted, or waiting in a pending voucher) is a repeat
            const receiptText = String(dto.receiptNo ?? '').trim();
            if (receiptText) {
                const already = await qr.query(
                    `SELECT 1 FROM loan_repayment_ledger WHERE receipt_no = $1 AND loancaseno::text = $2 AND mbno::text = $3 LIMIT 1`,
                    [receiptText, caseNo, mbno]);
                if (already.length > 0) {
                    throw new BadRequestException(`Receipt number ${receiptText} is already recorded for this loan. If this is a new payment, use a different receipt number.`);
                }
            }

            const { plan, flag } = await this.loanRepayment.buildRepaymentPlan(qr, {
                mbno, loancaseno: caseNo, loantype, amount: dto.amount, asOfDate: dto.asOfDate,
                receiptNo: receiptText, narration: dto.narration,
            });

            const vid = await this.nextId(qr, 'vouchers', 'id');
            const hold = await qr.query(
                `INSERT INTO loan_repayment_holds
                    (voucher_no, mbno, loancaseno, loantype, status, pay_mode, bank_code, quoted_on, amount, receipt_no, plan, created_by)
                 VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7::date,$8,$9,$10::jsonb,$11) RETURNING id`,
                [voucherNo, mbno, caseNo, loantype, mode, dto.bankCode || null, plan.quotedOn, plan.amount, receiptText || null, JSON.stringify(plan), createdBy]);
            const holdId = hold[0].id;

            await qr.query(
                `INSERT INTO vouchers ("id","voucherNumber","voucherDate","voucherType","totalAmount","description","memberId","payeeName",
                                       "status","remarks","bankName","createdAt","businessEvent","sourceModule","sourceId")
                 VALUES ($1,$2,NOW()::date,'RECEIPT',$3,$4,$5,'','PENDING',$6,$7,NOW(),$8,$9,$10)`,
                [vid, voucherNo, plan.amount,
                    dto.narration || `Loan Repayment - case ${caseNo}`, mbno,
                    `RCASE:${caseNo}|HOLD:${holdId}|PAY_MODE:${mode}${dto.bankCode ? `|BANK:${dto.bankCode}` : ''}`,
                    mode === 'BANK' ? 'BANK' : null, LOAN_REPAYMENT_SOURCE_MODULE, LOAN_REPAYMENT_SOURCE_MODULE, String(holdId)]);

            // What Pass will post, one line each so the approver can read it: principal, interest and penal (same
            // income head as interest, like early closure), and the cash / bank received.
            const lines: Array<{ type: 'R' | 'DR'; code: string; amount: number; name: string; accType: string }> = [
                { type: 'R', code: this.principalHead(loantype), amount: plan.principal, name: `Loan repayment principal - case ${caseNo}`, accType: loantype },
                { type: 'R', code: interestHeadForLoanType(loantype), amount: plan.interest, name: `Loan repayment interest - case ${caseNo}`, accType: 'OTH' },
                { type: 'R', code: interestHeadForLoanType(loantype), amount: plan.penal, name: `Loan repayment penal interest - case ${caseNo}`, accType: 'OTH' },
                { type: 'DR', code: mode === 'CASH' ? 'A1001' : String(dto.bankCode), amount: plan.amount, name: `Loan repayment received - case ${caseNo}`, accType: mode === 'CASH' ? 'CINH' : 'BANK' },
            ];
            let transNo = await this.nextId(qr, 'transactions', 'trans_no');
            for (const l of lines) {
                if (!(l.amount > 0)) continue;
                await qr.query(
                    `INSERT INTO transactions (trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, vchr_type, modeofpay,
                                               pass_flag, cashier_flag, narration, code, username, acc_type, cheq_amt)
                     VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7,'N','N',$8,$9,$10,$11,0)`,
                    [transNo++, l.type, mbno, l.amount, voucherNo, VOUCHER_TYPE_CODE, mode === 'CASH' ? 'C' : 'B',
                        l.name.slice(0, 250), l.code, createdBy, l.accType]);
            }
            await qr.commitTransaction();
            return {
                success: true,
                message: `Repayment of ₹${plan.amount.toLocaleString('en-IN')} on loan ${caseNo} is waiting in Past Transaction (voucher ${voucherNo}). It is posted when it is passed.`,
                voucherNo, holdId, amount: plan.amount, plan,
                ...(flag ? { flag } : {}),
            };
        } catch (e) {
            await qr.rollbackTransaction();
            throw e;
        } finally {
            await qr.release();
        }
    }

    // ------------------------------------------------------------------ Pass (runs INSIDE the caller's transaction)
    async passInTransaction(qr: QueryRunner, voucherNo: string, header: any, details: any[], postedBy: string) {
        const hold = await this.getByVoucher(qr, voucherNo, true);
        if (!hold) throw new Error('Loan repayment record not found for this voucher');
        if (hold.status !== 'PENDING') throw new Error(`Loan repayment ${voucherNo} is ${hold.status}; this voucher cannot be passed`);
        const plan: RepaymentPlan = typeof hold.plan === 'string' ? JSON.parse(hold.plan) : hold.plan;

        const loanRows = await qr.query(
            `SELECT mbno, loantype, balance FROM loan_master
              WHERE loancaseno::text = $1 AND mbno = $2 AND loantype = $3 FOR UPDATE`,
            [hold.loancaseno, hold.mbno, hold.loantype]);
        const loan = loanRows[0];
        if (!loan || num(loan.balance) <= 0) throw new Error(`Loan ${hold.loancaseno} is no longer active; reject this voucher`);
        if (Math.abs(num(loan.balance) - num(plan.expectedLoanBalance)) > BALANCE_TOLERANCE) {
            throw new BadRequestException(
                `Loan ${hold.loancaseno} changed since this repayment was raised (balance ₹${round2(num(loan.balance))}, was ₹${round2(num(plan.expectedLoanBalance))}). Reject this voucher and raise a new repayment.`);
        }

        const today = new Date();
        await assertPostingDateOpen(qr, today); // ES-458

        // The dues must still be what they were when the voucher was raised (a new month may have added a penalty).
        let fresh: RepaymentPlan;
        try {
            fresh = (await this.loanRepayment.buildRepaymentPlan(qr, {
                mbno: hold.mbno, loancaseno: hold.loancaseno, loantype: hold.loantype, amount: plan.amount, asOfDate: today,
            })).plan;
        } catch (e: any) {
            throw new BadRequestException(`The dues of loan ${hold.loancaseno} changed since this repayment was raised: ${e?.message || e}. Reject this voucher and raise a new repayment.`);
        }
        if (Math.abs(fresh.principal - plan.principal) > 0.01 || Math.abs(fresh.interest - plan.interest) > 0.01
            || Math.abs(fresh.penal - plan.penal) > 0.01 || Math.abs(fresh.dueTotal - plan.dueTotal) > 0.01) {
            throw new BadRequestException(
                `The dues of loan ${hold.loancaseno} changed since this repayment was raised (now ₹${fresh.dueTotal} due, was ₹${plan.dueTotal}; penal now ₹${fresh.penal}, was ₹${plan.penal}). Reject this voucher and raise a new repayment.`);
        }

        const receiptNo = hold.receipt_no || voucherNo;
        if (hold.receipt_no) {
            const already = await qr.query(
                `SELECT 1 FROM loan_repayment_ledger WHERE receipt_no = $1 AND loancaseno::text = $2 AND mbno::text = $3 LIMIT 1`,
                [hold.receipt_no, hold.loancaseno, hold.mbno]);
            if (already.length > 0) throw new BadRequestException(`Receipt number ${hold.receipt_no} is already recorded for this loan. Reject this voucher.`);
        }

        // 1. loan sub-ledger: replay the frozen rows (dated on the pass date)
        for (const r of plan.rows) {
            await qr.query(
                `INSERT INTO loan_repayment_ledger
                    (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                     principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by, payment_source)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'CASH')`,
                [hold.mbno, hold.loancaseno, hold.loantype, today, r.month, r.year, r.amount, r.principal, r.interest, r.penal,
                    r.monthsOverdue, receiptNo, r.narration, postedBy]);
            await qr.query(
                `UPDATE demand_master SET balance_for_month = GREATEST(0, balance_for_month - $1)
                  WHERE mbno = $2 AND demand_for_month = $3 AND demand_for_year = $4`,
                [r.principal + r.interest, hold.mbno, r.month, r.year]);
        }

        // 2. loan account balance, member loan balance, RD lien
        await qr.query(
            `UPDATE loan_master SET balance = GREATEST(0, COALESCE(balance, 0) - $1) WHERE loancaseno::text = $2 AND mbno = $3 AND loantype = $4`,
            [plan.principal, hold.loancaseno, hold.mbno, hold.loantype]);
        const lt = String(hold.loantype || '').toUpperCase();
        const isEmergency = ['ELN', 'ALN', 'A', 'E', 'EMR', 'ADD'].includes(lt) || lt.includes('EMERGENCY');
        await qr.query(
            isEmergency
                ? `UPDATE member_balances SET emergency_loan_balance = GREATEST(0, COALESCE(emergency_loan_balance, 0) - $1) WHERE mbno = $2`
                : `UPDATE member_balances SET regularloan = GREATEST(0, COALESCE(regularloan, 0) - $1) WHERE mbno = $2`,
            [plan.principal, hold.mbno]);
        await this.loanRepayment.releaseRdLienIfClosed(qr, hold.loancaseno, hold.mbno, hold.loantype, postedBy, 'LOAN FULLY REPAID');

        // 3. general ledger + cash book (all of it is cash / bank received; no RD or Share is touched)
        await lockLedgerIds(qr);
        const maxLedger = await qr.query(`SELECT COALESCE(MAX(ledgerid), 0) AS m FROM ledger`);
        let ledgerId = parseInt(maxLedger[0].m, 10) + 1;
        const maxTrans = await qr.query(`SELECT COALESCE(MAX(trans_no), 0) AS m FROM ledger`);
        let transNo = parseInt(maxTrans[0].m, 10) + 1;
        const interestHead = interestHeadForLoanType(hold.loantype);
        const principalHead = this.principalHead(hold.loantype);
        const cashHead = hold.pay_mode === 'BANK' ? String(hold.bank_code) : 'A1001';
        const mode = hold.pay_mode === 'BANK' ? 'T' : 'C';
        const narr = `Loan repayment - case ${hold.loancaseno}`;
        const interestTotal = round2(plan.interest + plan.penal);

        const post = async (code: string, direction: 'DR' | 'CR', amount: number, accNo: any, accType: string, text: string) => {
            if (!(amount > 0)) return;
            await qr.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type,
                                     modeofpay, pl_balance, narration, username, ledgerid)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,$13,$14)`,
                [transNo++, today, direction, code, hold.mbno, accNo, accType, amount, voucherNo, VOUCHER_TYPE_CODE, mode, text, postedBy, ledgerId++]);
        };
        await post(principalHead, await this.decreaseDirection(qr, principalHead), plan.principal, hold.loancaseno, hold.loantype, `${narr} - principal`);
        await post(interestHead, await this.increaseDirection(qr, interestHead), plan.interest, hold.loancaseno, 'OTH', `${narr} - interest`);
        await post(interestHead, await this.increaseDirection(qr, interestHead), plan.penal, hold.loancaseno, 'OTH', `${narr} - penal interest`);
        await post(cashHead, await this.increaseDirection(qr, cashHead), plan.amount, 0, hold.pay_mode === 'BANK' ? 'BANK' : 'CINH', `${narr} - received`);

        for (const [code, amt, text] of [
            [principalHead, plan.principal, `${narr} - principal`],
            [interestHead, interestTotal, `${narr} - interest`],
        ] as Array<[string, number, string]>) {
            if (!(amt > 0)) continue;
            await qr.query(
                `INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date, voucher_no, username)
                 VALUES ($1,$2,$3,$4,0,0,$5,$6,$7)`,
                [code, text, mode === 'C' ? amt : 0, mode === 'C' ? 0 : amt, today, voucherNo, postedBy]);
        }

        await qr.query(`UPDATE loan_repayment_holds SET status = 'POSTED', passed_at = NOW() WHERE id = $1`, [hold.id]);
        this.logger.log(`Loan repayment ${voucherNo} passed: loan ${hold.loancaseno}, principal ${plan.principal}, interest ${plan.interest}, penal ${plan.penal}`);
        return {
            voucherNo, loancaseno: hold.loancaseno, amount: plan.amount,
            principal: plan.principal, interest: plan.interest, penal: plan.penal,
            newBalance: round2(Math.max(0, num(loan.balance) - plan.principal)),
        };
    }

    /** Voucher deleted / rejected in Past Transaction: the repayment is cancelled, nothing was posted. */
    async onVoucherRejected(qr: QueryRunner, voucherNo: string) {
        await this.ensureTable(qr);
        await qr.query(`UPDATE loan_repayment_holds SET status = 'CANCELLED', cancelled_at = NOW() WHERE voucher_no = $1 AND status = 'PENDING'`, [voucherNo]);
    }
}
