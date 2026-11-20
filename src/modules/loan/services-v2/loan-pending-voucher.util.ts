import { BadRequestException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

/**
 * One pending voucher per loan.
 *
 * A loan can have only ONE money event waiting for Pass at a time: a repayment, an early closure or a
 * re-agreement. A second one would be worked out on figures the first one is about to change (the closure would
 * collect principal the repayment also pays, a repayment would pay dues a closure already covers). So every window
 * that raises one of these asks this question first and is refused with the voucher to clear.
 *
 * Plain functions (no DI) so the loan windows can all share them without import cycles.
 */
export type PendingVoucherKind = 'REPAYMENT' | 'EARLY_CLOSURE' | 'REAGREEMENT';

export interface PendingVoucher {
    kind: PendingVoucherKind;
    /** Voucher number to accept or reject (the re-agreement number when it has no voucher yet). */
    reference: string;
    /** Extra detail for the message, e.g. the re-agreement status. */
    detail?: string;
}

const KIND_LABEL: Record<PendingVoucherKind, string> = {
    REPAYMENT: 'loan repayment',
    EARLY_CLOSURE: 'early closure',
    REAGREEMENT: 're-agreement',
};

type Runner = DataSource | QueryRunner;

async function tableExists(runner: Runner, table: string): Promise<boolean> {
    const r = await runner.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table]);
    return r[0]?.ok === true;
}

/**
 * The pending voucher of a loan, or null. Looks in the early-closure holds, the re-agreements that are applied /
 * sanctioned / vouchered but not passed, and the repayment holds. Tables that do not exist yet are skipped.
 */
export async function findPendingVoucherForLoan(runner: Runner, mbno: string, loancaseno: string): Promise<PendingVoucher | null> {
    const mb = String(mbno);
    const caseNo = String(loancaseno);

    if (await tableExists(runner, 'loan_repayment_holds')) {
        const r = await runner.query(
            `SELECT voucher_no FROM loan_repayment_holds WHERE mbno::text = $1 AND loancaseno::text = $2 AND status = 'PENDING' LIMIT 1`,
            [mb, caseNo],
        );
        if (r.length > 0) return { kind: 'REPAYMENT', reference: String(r[0].voucher_no) };
    }

    if (await tableExists(runner, 'loan_early_closure_holds')) {
        const r = await runner.query(
            `SELECT voucher_no FROM loan_early_closure_holds WHERE mbno::text = $1 AND loancaseno::text = $2 AND status = 'PENDING' LIMIT 1`,
            [mb, caseNo],
        );
        if (r.length > 0) return { kind: 'EARLY_CLOSURE', reference: String(r[0].voucher_no) };
    }

    if (await tableExists(runner, 'loan_reagreements')) {
        const r = await runner.query(
            `SELECT reagreement_no, status FROM loan_reagreements
              WHERE mbno::text = $1 AND old_loancaseno::text = $2 AND status IN ('APPLIED','SANCTIONED','VOUCHERED') LIMIT 1`,
            [mb, caseNo],
        );
        if (r.length > 0) return { kind: 'REAGREEMENT', reference: String(r[0].reagreement_no), detail: String(r[0].status) };
    }

    return null;
}

/**
 * Transaction-scoped lock shared by every window that raises a pending voucher on a loan. Take it before
 * assertNoPendingVoucher so that two requests cannot both see "nothing pending" and both raise one.
 */
export async function lockLoanForPendingVoucher(runner: QueryRunner, mbno: string, loancaseno: string): Promise<void> {
    await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`loan_pending_voucher:${mbno}:${loancaseno}`]);
}

/**
 * Refuses when the loan already has a pending voucher. `action` is what the caller is trying to do, for the message.
 * Call it inside the transaction, after the per-loan lock, so two clicks at once cannot both pass.
 */
export async function assertNoPendingVoucher(
    runner: Runner,
    mbno: string,
    loancaseno: string,
    action: string,
): Promise<void> {
    const pending = await findPendingVoucherForLoan(runner, mbno, loancaseno);
    if (!pending) return;
    const what = pending.kind === 'REAGREEMENT'
        ? `an open re-agreement (${pending.reference}${pending.detail ? `, ${pending.detail}` : ''})`
        : `a pending ${KIND_LABEL[pending.kind]} (voucher ${pending.reference})`;
    const next = pending.kind === 'REAGREEMENT'
        ? 'Cancel or pass it first'
        : 'Accept or reject that voucher in Past Transaction first';
    throw new BadRequestException(`You cannot ${action} on loan ${loancaseno} now: it has ${what}. ${next}, then come back.`);
}
