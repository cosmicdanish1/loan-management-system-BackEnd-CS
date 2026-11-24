/**
 * ES-581: the inputs of the RD/CD year-end interest, read from the LEDGER the way the legacy worked it out.
 *
 * The RD/CD engine used to read `rd_installment_ledger` and `rd_balance_events`. Payroll deposits of migrated members are
 * plain ledger rows (head L1004), and migrated members have no timeline at all, so the engine saw nothing and credited 0.
 * The money itself is always in the ledger, so that is where the engine now looks:
 *
 *   opening     = the RD/CD balance on the first day of the financial year
 *                 = fundsmaster.cdopbal (the balance carried into the ledger) + every L1004 ledger row before that day
 *   deposits    = credits to L1004 inside the year, by date
 *   withdrawals = debits from L1004 inside the year, by date
 *
 * Three kinds of journal move RD/CD without being a member's own deposit or withdrawal, and are left out (they are the
 * interest itself, the dividend credited to CD, and the group insurance premium taken from CD):
 *   - a credit whose voucher also debits E1026 (interest on compulsory deposit) or L1024 (dividend paid) for the same member;
 *   - a debit whose voucher also credits L1003 (member group accidental insurance) for the same member.
 * This matches the legacy: its yearly interest reproduced from exactly these inputs (opening x rate + deposits by the
 * remaining-months chart, withdrawals lowering the base from their month) is within 1% of what the legacy posted.
 */
export interface RdLedgerMovement {
    /** local calendar date, YYYY-MM-DD */
    date: string;
    amount: number;
}

export interface RdLedgerInputs {
    opening: number;
    deposits: RdLedgerMovement[];
    withdrawals: RdLedgerMovement[];
}

type Runner = { query: (sql: string, params?: any[]) => Promise<any> };

const CREDIT = `('CR', 'R')`;
const DEBIT = `('DR', 'P')`;

/** The member's RD/CD balance at the start of `fyStart` (YYYY-MM-DD): carried-in balance + ledger rows before that day. */
export async function loadRdCdOpening(runner: Runner, mbno: string, fyStart: string): Promise<number> {
    const rows = await runner.query(
        `SELECT COALESCE((SELECT MAX(cdopbal) FROM fundsmaster WHERE mbno::numeric = $1::numeric), 0)::float
              + COALESCE((SELECT SUM(CASE WHEN UPPER(TRIM(trans_type)) IN ${CREDIT} THEN trans_amt ELSE -trans_amt END)
                            FROM ledger WHERE mbno::numeric = $1::numeric AND TRIM(code) = 'L1004' AND trans_date::date < $2::date), 0)::float AS opening`,
        [mbno, fyStart],
    );
    return Math.round(Number(rows?.[0]?.opening || 0) * 100) / 100;
}

/** Deposits and withdrawals inside [fyStart, fyEnd] (YYYY-MM-DD), the interest / dividend / insurance journals left out. */
export async function loadRdCdMovements(runner: Runner, mbno: string, fyStart: string, fyEnd: string): Promise<{ deposits: RdLedgerMovement[]; withdrawals: RdLedgerMovement[] }> {
    const rows = await runner.query(
        `SELECT to_char(l.trans_date, 'YYYY-MM-DD') AS d, l.trans_amt::float AS amt, UPPER(TRIM(l.trans_type)) AS t
           FROM ledger l
          WHERE l.mbno::numeric = $1::numeric AND TRIM(l.code) = 'L1004'
            AND l.trans_date::date >= $2::date AND l.trans_date::date <= $3::date
            AND NOT EXISTS (
                SELECT 1 FROM ledger o
                 WHERE o.receipt_vchr_no = l.receipt_vchr_no AND COALESCE(l.receipt_vchr_no, '') <> '' AND o.mbno::numeric = l.mbno::numeric
                   AND ((UPPER(TRIM(l.trans_type)) IN ${CREDIT} AND TRIM(o.code) IN ('E1026', 'L1024') AND UPPER(TRIM(o.trans_type)) IN ${DEBIT})
                     OR (UPPER(TRIM(l.trans_type)) IN ${DEBIT} AND TRIM(o.code) = 'L1003' AND UPPER(TRIM(o.trans_type)) IN ${CREDIT}))
            )
          ORDER BY l.trans_date, l.ledgerid`,
        [mbno, fyStart, fyEnd],
    );
    const deposits: RdLedgerMovement[] = [];
    const withdrawals: RdLedgerMovement[] = [];
    for (const r of rows || []) {
        const amount = Number(r.amt) || 0;
        if (!(amount > 0)) continue;
        (['CR', 'R'].includes(r.t) ? deposits : withdrawals).push({ date: String(r.d), amount });
    }
    return { deposits, withdrawals };
}

/** 'YYYY-MM-DD' as a LOCAL date (new Date('YYYY-MM-DD') would be UTC midnight and can fall on the day before). */
export function localDateFromYmd(ymd: string): Date {
    const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
}

/** One instalment row of the member's year (rd_installment_ledger): what was due, what was paid and when. */
export interface RdInstallmentRow {
    /** the month the instalment was due (YYYY-MM-DD) */
    dueDate: string;
    /** when it was paid (YYYY-MM-DD), null while unpaid */
    paidDate: string | null;
    paidAmount: number;
    expectedAmount: number;
    /** how the row was made, e.g. "Collected via demand import" */
    narration: string;
}

/**
 * ES-629: the instalment rows of a member's financial year. They are the only place that knows the DUE month of a payment, which
 * the Allow / Deny decision needs (a late instalment earns from its due month when allowed, from the month it was paid when
 * denied). Migrated members have none (their deposits are plain ledger rows and count as paid on time).
 */
export async function loadRdInstallmentRows(runner: Runner, mbno: string, yearcode: number): Promise<RdInstallmentRow[]> {
    const rows = await runner.query(
        `SELECT to_char(due_date, 'YYYY-MM-DD') AS due, to_char(paid_date, 'YYYY-MM-DD') AS paid,
                COALESCE(paid_amount, 0)::float AS paid_amt, COALESCE(expected_amount, 0)::float AS exp_amt, COALESCE(narration, '') AS narr
           FROM rd_installment_ledger WHERE mbno::numeric = $1::numeric AND yearcode = $2 ORDER BY due_date ASC`,
        [mbno, yearcode],
    );
    return (rows || []).map((r: any) => ({ dueDate: String(r.due), paidDate: r.paid ? String(r.paid) : null, paidAmount: Number(r.paid_amt) || 0, expectedAmount: Number(r.exp_amt) || 0, narration: String(r.narr || '') }));
}

/**
 * Which months of the financial year have their monthly demand POSTED to the ledger (demand_master.demand_posted = 'Y').
 * The demand import writes an instalment row as soon as the file is imported, but the money reaches the main ledger only when
 * the demand is posted, so an imported-but-unposted month must not earn interest yet. Key 'YYYY-MM' -> posted.
 */
export async function loadDemandPostedMonths(runner: Runner, mbno: string, fyStart: string, fyEnd: string): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    try {
        const rows = await runner.query(
            `SELECT demand_for_year AS y, demand_for_month AS m, bool_or(demand_posted = 'Y') AS posted
               FROM demand_master WHERE mbno::numeric = $1::numeric
                AND (demand_for_year * 12 + demand_for_month) BETWEEN (EXTRACT(YEAR FROM $2::date)::int * 12 + EXTRACT(MONTH FROM $2::date)::int)
                                                                  AND (EXTRACT(YEAR FROM $3::date)::int * 12 + EXTRACT(MONTH FROM $3::date)::int)
              GROUP BY 1, 2`,
            [mbno, fyStart, fyEnd],
        );
        for (const r of rows || []) out.set(`${r.y}-${String(r.m).padStart(2, '0')}`, !!r.posted);
    } catch {
        // no demand table: nothing is known to be unposted
    }
    return out;
}
