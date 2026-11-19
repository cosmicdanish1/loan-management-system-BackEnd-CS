import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { SequenceGeneratorService } from '../../../shared/services';
import { SystemConfigService } from '../../../admin/services/system-config.service';
import { isDebitNormal } from '../../../shared/utils/balance-direction';
import { lockLedgerIds, lockNextId } from '../../../shared/utils/ledger-lock';
import { interestHeadForLoanType } from '../../loan-interest-heads';
import { EarlyClosurePlan, LoanRepaymentService } from '../loan-repayment.service';
import { round2 } from '../loan-rb-schedule.util';

/**
 * ES-556: Loan Early Closure held in Past Transaction.
 *
 * Every money movement goes through Past Transaction, so an early closure is raised as its own voucher
 * (sourceModule LOAN_EARLY_CLOSURE). When the employee ticks "close on next month's outstanding" the voucher
 * stays PENDING until the awaited EMI is received (Demand Posting / Import Demand / Loan Repayment), then it is
 * passed automatically (setting RULE_EARLY_CLOSURE_AUTO_PASS) or the employee is notified to pass it.
 *
 * The amount is FROZEN at quote time (EarlyClosurePlan): Pass replays the stored rows, nothing is recalculated and
 * no penalty is added. RD / Share available at Pass time settle the closure (RD first, then Share).
 */
export const EARLY_CLOSURE_SOURCE_MODULE = 'LOAN_EARLY_CLOSURE';
const VOUCHER_TYPE_CODE = 'EC'; // transactions.vchr_type / ledger.vchr_type (varchar(2))
const BALANCE_TOLERANCE = 4.01; // same allowance the closure rounding guard uses (ES-493)

export interface CreateClosureHoldDto {
    mbno: string;
    loancaseno: string;
    closureDate?: Date;
    adjustment?: number;
    applyRdShare?: boolean;
    adjustPayrollLag?: boolean;
    /** true: close on next month's outstanding and wait for the awaited EMI. false: raise the voucher for immediate Pass. */
    nextMonth?: boolean;
    paymentMode?: 'CASH' | 'BANK';
    bankCode?: string;
    narration?: string;
}

const num = (v: any, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

@Injectable()
export class LoanEarlyClosureHoldService {
    private readonly logger = new Logger(LoanEarlyClosureHoldService.name);
    private tableReady = false;

    constructor(
        private readonly dataSource: DataSource,
        private readonly sequenceGenerator: SequenceGeneratorService,
        private readonly systemConfigService: SystemConfigService,
        private readonly loanRepayment: LoanRepaymentService,
    ) {
        // the awaited EMI arrives through the ordinary repayment path (Loan Repayment, Import Demand, Demand Posting)
        this.loanRepayment.afterPaymentHooks.push((mbno, caseNo) => this.onLoanPayment(mbno, caseNo));
    }

    // ------------------------------------------------------------------ settings / helpers
    /** Modify Member Business Settings flag: true = the pending closure is passed automatically when the EMI arrives. */
    async isAutoPassOn(): Promise<boolean> {
        try {
            const v = await this.systemConfigService.getConfigValue('RULE_EARLY_CLOSURE_AUTO_PASS');
            return v === true || v === 'true' || v === 1 || v === '1';
        } catch {
            return false;
        }
    }

    async ensureTable(runner: DataSource | QueryRunner = this.dataSource): Promise<void> {
        if (this.tableReady) return;
        await runner.query(`CREATE TABLE IF NOT EXISTS loan_early_closure_holds (
            id SERIAL PRIMARY KEY,
            voucher_no VARCHAR(40) NOT NULL UNIQUE,
            mbno VARCHAR(20) NOT NULL,
            loancaseno VARCHAR(40) NOT NULL,
            loantype VARCHAR(10) NOT NULL,
            status VARCHAR(12) NOT NULL DEFAULT 'PENDING',
            next_month BOOLEAN NOT NULL DEFAULT FALSE,
            adjust_payroll_lag BOOLEAN NOT NULL DEFAULT FALSE,
            apply_rd_share BOOLEAN NOT NULL DEFAULT TRUE,
            pay_mode VARCHAR(4) NOT NULL DEFAULT 'CASH',
            bank_code VARCHAR(20),
            quoted_on DATE NOT NULL,
            expected_month DATE,
            final_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
            plan JSONB NOT NULL,
            created_by VARCHAR(60),
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            passed_at TIMESTAMP,
            cancelled_at TIMESTAMP
        )`);
        await runner.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_early_closure_hold_pending
            ON loan_early_closure_holds (mbno, loancaseno, loantype) WHERE status = 'PENDING'`);
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

    private async getRuleString(key: string, fallback: string): Promise<string> {
        try {
            const v = await this.systemConfigService.getConfigValue(key);
            return v === undefined || v === null || v === '' ? fallback : String(v);
        } catch {
            return fallback;
        }
    }

    /** Loan-account head: same convention as the disbursement voucher (RLN = A1002, every other type = A1047). */
    private principalHead(loantype: string): string {
        return String(loantype || '').toUpperCase() === 'RLN' ? 'A1002' : 'A1047';
    }

    private monthStartAfter(ymd: string): string {
        const m = /^(\d{4})-(\d{2})/.exec(ymd);
        const y = m ? parseInt(m[1], 10) : new Date().getFullYear();
        const mo = m ? parseInt(m[2], 10) : new Date().getMonth() + 1;
        const ny = mo === 12 ? y + 1 : y;
        const nm = mo === 12 ? 1 : mo + 1;
        return `${ny}-${String(nm).padStart(2, '0')}-01`;
    }

    async getByVoucher(runner: QueryRunner | DataSource, voucherNo: string, lock = false) {
        await this.ensureTable(runner);
        const r = await runner.query(`SELECT * FROM loan_early_closure_holds WHERE voucher_no = $1 ${lock ? 'FOR UPDATE' : ''}`, [voucherNo]);
        return r[0] || null;
    }

    /** The pending closure of a loan, if any (used by re-agreement and by the closure window). */
    async getPendingForLoan(mbno: string, loancaseno: string, runner: QueryRunner | DataSource = this.dataSource) {
        await this.ensureTable(runner);
        const r = await runner.query(
            `SELECT id, voucher_no, next_month, quoted_on::text AS quoted_on, expected_month::text AS expected_month, final_amount
               FROM loan_early_closure_holds WHERE mbno = $1 AND loancaseno = $2 AND status = 'PENDING' LIMIT 1`,
            [String(mbno), String(loancaseno)],
        );
        return r[0] || null;
    }

    async listPending() {
        await this.ensureTable();
        return this.dataSource.query(
            `SELECT id, voucher_no AS "voucherNo", mbno, loancaseno, loantype, next_month AS "nextMonth",
                    quoted_on::text AS "quotedOn", expected_month::text AS "expectedMonth", final_amount AS "finalAmount", created_by AS "createdBy"
               FROM loan_early_closure_holds WHERE status = 'PENDING' ORDER BY id`,
        );
    }

    // ------------------------------------------------------------------ create (loan window -> Past Transaction)
    async create(dto: CreateClosureHoldDto, createdBy: string) {
        await this.ensureTable();
        const mbno = String(dto.mbno || '').trim();
        const caseNo = String(dto.loancaseno || '').trim();
        if (!mbno || !caseNo) throw new BadRequestException('mbno and loan case number are required.');
        const nextMonth = dto.nextMonth === true;
        const mode: 'CASH' | 'BANK' = dto.paymentMode === 'BANK' ? 'BANK' : 'CASH';
        if (mode === 'BANK' && !dto.bankCode) throw new BadRequestException('Bank mode requires the bank head code (bankCode).');

        const loanRows = await this.dataSource.query(
            `SELECT mbno, loantype, balance FROM loan_master WHERE loancaseno::text = $1 AND mbno = $2`, [caseNo, mbno]);
        if (loanRows.length === 0) throw new NotFoundException(`Loan case ${caseNo} not found for member ${mbno}.`);
        if (num(loanRows[0].balance) <= 0) throw new BadRequestException(`Loan ${caseNo} is already fully repaid.`);
        const loantype = String(loanRows[0].loantype);

        const open = await this.dataSource.query(
            `SELECT reagreement_no, status FROM loan_reagreements
              WHERE mbno = $1 AND old_loancaseno::text = $2 AND status IN ('APPLIED','SANCTIONED','VOUCHERED') LIMIT 1`, [mbno, caseNo]);
        if (open.length > 0) {
            throw new BadRequestException(`Loan ${caseNo} has an open re-agreement (${open[0].reagreement_no}, ${open[0].status}); cancel it or pass it before an early closure.`);
        }

        const voucherNo = await this.sequenceGenerator.getNextVoucherNumber();

        // Dry run: the full closure is computed and written inside a transaction that is rolled back; we keep the rows.
        const dry = await this.loanRepayment.executeEarlyClosure(
            caseNo, dto.closureDate, dto.adjustment ?? 0, createdBy, voucherNo, dto.applyRdShare !== false, mbno,
            dto.adjustPayrollLag === true, nextMonth, true,
        );
        const plan = dry.plan as EarlyClosurePlan;
        if (!plan) throw new BadRequestException('The closure could not be planned.');
        const interestTotal = round2(plan.postedInterest + plan.postedPenal);
        if (interestTotal < 0) {
            throw new BadRequestException(`The closure interest nets to a negative figure (${interestTotal}) after the adjustments; this cannot be raised as a voucher. Review the closure figures.`);
        }
        if (plan.postedPrincipal < 0) throw new BadRequestException('The closure principal nets to a negative figure.');

        const qr = this.dataSource.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
            await qr.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`early_closure_hold:${mbno}:${caseNo}`]);
            await lockLedgerIds(qr);
            const pending = await qr.query(
                `SELECT voucher_no FROM loan_early_closure_holds WHERE mbno = $1 AND loancaseno = $2 AND loantype = $3 AND status = 'PENDING'`,
                [mbno, caseNo, loantype]);
            if (pending.length > 0) {
                throw new BadRequestException(`Loan ${caseNo} already has a pending early closure (voucher ${pending[0].voucher_no}). Pass or delete it first.`);
            }

            const vid = await this.nextId(qr, 'vouchers', 'id');
            const hold = await qr.query(
                `INSERT INTO loan_early_closure_holds
                    (voucher_no, mbno, loancaseno, loantype, status, next_month, adjust_payroll_lag, apply_rd_share, pay_mode, bank_code,
                     quoted_on, expected_month, final_amount, plan, created_by)
                 VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7,$8,$9,$10::date,$11::date,$12,$13::jsonb,$14) RETURNING id`,
                [voucherNo, mbno, caseNo, loantype, nextMonth, plan.adjustPayrollLag, dto.applyRdShare !== false, mode, dto.bankCode || null,
                    plan.quotedOn, nextMonth ? this.monthStartAfter(plan.quotedOn) : null, plan.finalClosureAmount, JSON.stringify(plan), createdBy]);
            const holdId = hold[0].id;

            await qr.query(
                `INSERT INTO vouchers ("id","voucherNumber","voucherDate","voucherType","totalAmount","description","memberId","payeeName",
                                       "status","remarks","bankName","createdAt","businessEvent","sourceModule","sourceId")
                 VALUES ($1,$2,NOW()::date,'RECEIPT',$3,$4,$5,'','PENDING',$6,$7,NOW(),$8,$9,$10)`,
                [vid, voucherNo, plan.finalClosureAmount,
                    dto.narration || `Loan Early Closure - case ${caseNo}${nextMonth ? " (on next month's outstanding)" : ''}`, mbno,
                    `ECASE:${caseNo}|HOLD:${holdId}|PAY_MODE:${mode}${dto.bankCode ? `|BANK:${dto.bankCode}` : ''}`,
                    mode === 'BANK' ? 'BANK' : null, EARLY_CLOSURE_SOURCE_MODULE, EARLY_CLOSURE_SOURCE_MODULE, String(holdId)]);

            const lines: Array<{ type: 'R' | 'DR'; code: string; amount: number; name: string; accType: string }> = [
                { type: 'R', code: this.principalHead(loantype), amount: plan.postedPrincipal, name: `Early closure principal - case ${caseNo}`, accType: loantype },
                { type: 'R', code: interestHeadForLoanType(loantype), amount: interestTotal, name: `Early closure interest - case ${caseNo}`, accType: 'OTH' },
                { type: 'DR', code: mode === 'CASH' ? 'A1001' : String(dto.bankCode), amount: plan.finalClosureAmount, name: `Early closure received - case ${caseNo}`, accType: mode === 'CASH' ? 'CINH' : 'BANK' },
            ];
            let transNo = await this.nextId(qr, 'transactions', 'trans_no');
            for (const l of lines) {
                if (l.amount === 0) continue;
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
                message: nextMonth
                    ? `Early closure of loan ${caseNo} is held in Past Transaction (voucher ${voucherNo}) until the next EMI is received.`
                    : `Early closure of loan ${caseNo} is waiting in Past Transaction (voucher ${voucherNo}).`,
                voucherNo, holdId, finalClosureAmount: plan.finalClosureAmount, nextMonth,
                expectedMonth: nextMonth ? this.monthStartAfter(plan.quotedOn) : null,
            };
        } catch (e) {
            await qr.rollbackTransaction();
            throw e;
        } finally {
            await qr.release();
        }
    }

    // ------------------------------------------------------------------ Pass (runs INSIDE the caller's transaction)
    /**
     * The awaited EMI has been received when loan_master.balance has come down to what the plan expects. Used both to
     * gate Pass and to drive the auto-pass / notification.
     */
    private emiReceived(plan: EarlyClosurePlan, balance: number, nextMonth: boolean): boolean {
        if (!nextMonth) return true;
        return Math.abs(round2(balance) - round2(plan.expectedLoanBalance)) <= BALANCE_TOLERANCE
            || round2(balance) < round2(plan.expectedLoanBalance);
    }

    async passInTransaction(qr: QueryRunner, voucherNo: string, header: any, details: any[], postedBy: string) {
        const hold = await this.getByVoucher(qr, voucherNo, true);
        if (!hold) throw new Error('Early closure record not found for this voucher');
        if (hold.status !== 'PENDING') throw new Error(`Early closure ${voucherNo} is ${hold.status}; this voucher cannot be passed`);
        const plan: EarlyClosurePlan = typeof hold.plan === 'string' ? JSON.parse(hold.plan) : hold.plan;

        const loanRows = await qr.query(
            `SELECT mbno, loantype, balance, consolidated_into_loancaseno FROM loan_master
              WHERE loancaseno::text = $1 AND mbno = $2 AND loantype = $3 FOR UPDATE`,
            [hold.loancaseno, hold.mbno, hold.loantype]);
        const loan = loanRows[0];
        if (!loan || num(loan.balance) <= 0 || loan.consolidated_into_loancaseno !== null) {
            throw new Error(`Loan ${hold.loancaseno} is no longer active; reject this voucher`);
        }
        const balance = num(loan.balance);
        if (hold.next_month && !this.emiReceived(plan, balance, true)) {
            throw new BadRequestException(
                `The awaited EMI of loan ${hold.loancaseno} has not been received yet: loan balance is ₹${round2(balance)}, ` +
                `₹${round2(plan.expectedLoanBalance)} is expected once it is received. The closure stays in Past Transaction until then.`);
        }
        if (hold.next_month && balance < plan.expectedLoanBalance - BALANCE_TOLERANCE) {
            throw new BadRequestException(
                `Loan ${hold.loancaseno} balance ₹${round2(balance)} is lower than the ₹${round2(plan.expectedLoanBalance)} this closure was quoted on ` +
                `(the received payment was larger than the awaited EMI). Reject this voucher and raise a new closure.`);
        }
        if (!hold.next_month && Math.abs(balance - plan.expectedLoanBalance) > BALANCE_TOLERANCE) {
            throw new BadRequestException(
                `Loan ${hold.loancaseno} changed since the closure was quoted (balance ₹${round2(balance)}, quoted on ₹${round2(plan.expectedLoanBalance)}). Reject this voucher and raise a new closure.`);
        }

        const today = new Date();
        const todayLabel = today.toISOString().slice(0, 10);

        // 1. loan sub-ledger: replay the frozen rows (dated on the pass date)
        for (const r of plan.rows) {
            await qr.query(
                `INSERT INTO loan_repayment_ledger
                    (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                     principal_amount, interest_amount, penal_amount, months_overdue, receipt_no, narration, posted_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                [hold.mbno, hold.loancaseno, hold.loantype, today, r.month, r.year, r.amount, r.principal, r.interest, r.penal,
                    r.monthsOverdue, voucherNo, r.narration, postedBy]);
        }
        if (plan.adjustPayrollLag && (plan.payrollLagRefundDue > 0 || plan.payrollLagInterestRefundDue > 0)) {
            await this.loanRepayment.recordPayrollLagRefundInTx(qr, {
                mbno: hold.mbno, loantype: hold.loantype, loancaseno: hold.loancaseno,
                principal: plan.payrollLagRefundDue, interest: plan.payrollLagInterestRefundDue, refundedOn: today,
                voucherNo, narration: 'Netted against early-closure payment (delayed predecessor payroll principal and interest, accounted separately)',
                recordedBy: postedBy, kind: 'NETTED_AT_CLOSURE',
            });
        }

        // 2. loan account: balance 0, lien released, member loan balance down
        await this.loanRepayment.closeLoanAccountSideEffects(qr, hold.loancaseno, { mbno: hold.mbno, loantype: hold.loantype }, plan.outstandingPrincipal, postedBy);

        // 3. RD / Share available NOW settle as much as they can (RD first)
        const { fromRd, fromShare } = await this.loanRepayment.applyRdShareForClosure(
            qr, hold.loancaseno, { mbno: hold.mbno }, plan.finalClosureAmount, today, postedBy, hold.apply_rd_share !== false);
        const cashPart = round2(plan.finalClosureAmount - fromRd - fromShare);

        // 4. general ledger + cash book
        await lockLedgerIds(qr);
        const maxLedger = await qr.query(`SELECT COALESCE(MAX(ledgerid), 0) AS m FROM ledger`);
        let ledgerId = parseInt(maxLedger[0].m, 10) + 1;
        const maxTrans = await qr.query(`SELECT COALESCE(MAX(trans_no), 0) AS m FROM ledger`);
        let transNo = parseInt(maxTrans[0].m, 10) + 1;
        const rdHead = await this.getRuleString('RULE_LOAN_R_RD_HEAD_CODE', 'L1004');
        const shareHead = await this.getRuleString('RULE_LOAN_R_SHARE_HEAD_CODE', 'L1001');
        const interestTotal = round2(plan.postedInterest + plan.postedPenal);
        const cashHead = hold.pay_mode === 'BANK' ? String(hold.bank_code) : 'A1001';
        const mode = hold.pay_mode === 'BANK' ? 'T' : 'C';
        const narr = `Loan early closure - case ${hold.loancaseno}`;

        const post = async (code: string, direction: 'DR' | 'CR', amount: number, accNo: any, accType: string, text: string) => {
            if (!(amount > 0)) return;
            await qr.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type,
                                     modeofpay, pl_balance, narration, username, ledgerid)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,$13,$14)`,
                [transNo++, today, direction, code, hold.mbno, accNo, accType, amount, voucherNo, VOUCHER_TYPE_CODE, mode, text, postedBy, ledgerId++]);
        };
        await post(this.principalHead(hold.loantype), await this.decreaseDirection(qr, this.principalHead(hold.loantype)),
            plan.postedPrincipal, hold.loancaseno, hold.loantype, `${narr} - principal`);
        await post(interestHeadForLoanType(hold.loantype), await this.increaseDirection(qr, interestHeadForLoanType(hold.loantype)),
            interestTotal, hold.loancaseno, 'OTH', `${narr} - interest`);
        await post(cashHead, await this.increaseDirection(qr, cashHead), cashPart, 0, hold.pay_mode === 'BANK' ? 'BANK' : 'CINH', `${narr} - received`);
        await post(rdHead, await this.decreaseDirection(qr, rdHead), fromRd, hold.loancaseno, 'CD', `${narr} - adjusted from RD`);
        await post(shareHead, await this.decreaseDirection(qr, shareHead), fromShare, hold.loancaseno, 'SHR', `${narr} - adjusted from Share`);

        // Cash book is head-wise: principal then interest take the CASH actually received; the RD / Share part moves no cash.
        let cashLeft = cashPart;
        for (const [code, amt, text] of [
            [this.principalHead(hold.loantype), plan.postedPrincipal, `${narr} - principal`],
            [interestHeadForLoanType(hold.loantype), interestTotal, `${narr} - interest`],
        ] as Array<[string, number, string]>) {
            if (!(amt > 0)) continue;
            const part = round2(Math.min(amt, Math.max(0, cashLeft)));
            cashLeft = round2(cashLeft - part);
            await qr.query(
                `INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date, voucher_no, username)
                 VALUES ($1,$2,$3,$4,0,0,$5,$6,$7)`,
                [code, text, mode === 'C' ? part : 0, mode === 'C' ? 0 : part, today, voucherNo, postedBy]);
        }

        await qr.query(`UPDATE loan_early_closure_holds SET status = 'POSTED', passed_at = NOW() WHERE id = $1`, [hold.id]);
        this.logger.log(`Early closure ${voucherNo} passed on ${todayLabel}: loan ${hold.loancaseno}, RD ${fromRd}, Share ${fromShare}, received ${cashPart}`);
        return {
            voucherNo, loancaseno: hold.loancaseno, finalClosureAmount: plan.finalClosureAmount,
            fromRd, fromShare, receivedByMember: cashPart, nextMonth: hold.next_month,
        };
    }

    /** Voucher deleted / rejected in Past Transaction: the closure is cancelled and the loan stays open. */
    async onVoucherRejected(qr: QueryRunner, voucherNo: string) {
        await this.ensureTable(qr);
        await qr.query(`UPDATE loan_early_closure_holds SET status = 'CANCELLED', cancelled_at = NOW() WHERE voucher_no = $1 AND status = 'PENDING'`, [voucherNo]);
    }

    // ------------------------------------------------------------------ the awaited EMI arrives
    /**
     * Called after any payment is recorded on a loan (Loan Repayment, Import Demand, Demand Posting all end in
     * recordLoanRepayment). If a closure is waiting on this loan and the awaited EMI is now in, pass it
     * (auto-pass on) or leave it for the notification (auto-pass off). Never throws into the payment that triggered it.
     */
    async onLoanPayment(mbno: string, loancaseno: string): Promise<{ passed: boolean; voucherNo?: string; reason?: string }> {
        try {
            await this.ensureTable();
            const pending = await this.getPendingForLoan(mbno, loancaseno);
            if (!pending || !pending.next_month) return { passed: false };
            if (!(await this.isAutoPassOn())) return { passed: false, voucherNo: pending.voucher_no, reason: 'auto-pass is off; the employee is notified' };
            // Pass through the real Pass service so every guard (open day, locks, voucher status) applies.
            const passer = LoanEarlyClosureHoldService.passTransactionProvider?.();
            if (!passer) return { passed: false, voucherNo: pending.voucher_no, reason: 'pass service unavailable' };
            await passer(pending.voucher_no, 'system (auto-pass)');
            return { passed: true, voucherNo: pending.voucher_no };
        } catch (e: any) {
            this.logger.warn(`Auto-pass of the early closure on loan ${loancaseno} did not run: ${e?.message || e}`);
            return { passed: false, reason: String(e?.message || e) };
        }
    }

    /** Set by the module wiring: lets this service call PassTransactionService.passTransaction without a circular import. */
    static passTransactionProvider?: () => ((voucherNo: string, postedBy: string) => Promise<any>) | null;
}
