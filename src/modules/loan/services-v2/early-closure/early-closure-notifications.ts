import { DataSource } from 'typeorm';

/**
 * ES-556: Notification Centre conditions for early closures waiting in Past Transaction.
 *
 * Live conditions (the Notification Centre resolves a row once the condition no longer holds, i.e. once the voucher is
 * posted or deleted):
 *   - awaited EMI received, auto-pass OFF   -> info:    ready to pass in Past Transaction
 *   - expected month, from the 15th          -> warning: awaited EMI not received yet
 *   - last day of the expected month onward  -> error:   month-end reached, still not received
 */
export interface EarlyClosureNotice {
    kind: 'EARLY_CLOSURE_PENDING';
    severity: 'info' | 'warning' | 'error';
    title: string;
    body: string;
    mbno: string;
    dedupe_key: string;
    action_path: string;
    action_label: string;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const BALANCE_TOLERANCE = 4.01;

export async function detectEarlyClosureNotices(dataSource: DataSource): Promise<EarlyClosureNotice[]> {
    const tableRows = await dataSource.query(`SELECT to_regclass('public.loan_early_closure_holds') AS t`);
    if (!tableRows[0]?.t) return [];

    const cfg = await dataSource.query(
        `SELECT value FROM system_configs WHERE key = 'RULE_EARLY_CLOSURE_AUTO_PASS' AND "isActive" = true LIMIT 1`);
    const autoPass = ['true', '1', 'yes'].includes(String(cfg[0]?.value ?? '').toLowerCase());

    const rows = await dataSource.query(
        `SELECT h.voucher_no, h.mbno, h.loancaseno, h.final_amount::float AS final_amount,
                h.expected_month::text AS expected_month, h.plan, l.balance::float AS balance
           FROM loan_early_closure_holds h
           LEFT JOIN loan_master l ON l.loancaseno::text = h.loancaseno AND l.mbno::text = h.mbno AND l.loantype = h.loantype
          WHERE h.status = 'PENDING' AND h.next_month = TRUE`);

    const out: EarlyClosureNotice[] = [];
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    for (const r of rows) {
        const plan = typeof r.plan === 'string' ? JSON.parse(r.plan) : r.plan;
        const expectedBalance = round2(plan?.expectedLoanBalance);
        const received = r.balance !== null && r.balance !== undefined
            && (Math.abs(round2(r.balance) - expectedBalance) <= BALANCE_TOLERANCE || round2(r.balance) < expectedBalance);

        const expected = String(r.expected_month || '').slice(0, 10); // first day of the month the EMI is awaited in
        const [ey, em] = expected.split('-').map((x: string) => parseInt(x, 10));
        const lastDay = ey && em ? new Date(ey, em, 0) : null;
        const monthEnd = lastDay ? `${lastDay.getFullYear()}-${pad(lastDay.getMonth() + 1)}-${pad(lastDay.getDate())}` : '';

        const label = `Loan ${r.loancaseno} of member ${r.mbno}`;
        const base = { kind: 'EARLY_CLOSURE_PENDING' as const, mbno: String(r.mbno), action_path: '/transactions/pass-transactions', action_label: 'Open Past Transaction' };

        if (received) {
            if (!autoPass) {
                out.push({ ...base, severity: 'info', dedupe_key: `ec-ready:${r.voucher_no}`,
                    title: `${label}: awaited EMI received, early closure ready to pass`,
                    body: `Voucher ${r.voucher_no} (₹${round2(r.final_amount)}) can be passed in Past Transaction now.` });
            }
            continue;
        }
        if (monthEnd && today >= monthEnd) {
            out.push({ ...base, severity: 'error', dedupe_key: `ec-monthend:${r.voucher_no}`,
                title: `${label}: month-end reached and the awaited EMI is still not received`,
                body: `Early closure voucher ${r.voucher_no} (₹${round2(r.final_amount)}) is still waiting in Past Transaction. Check the demand / repayment of this member.` });
        } else if (expected && today >= `${expected.slice(0, 8)}15`) {
            out.push({ ...base, severity: 'warning', dedupe_key: `ec-late:${r.voucher_no}`,
                title: `${label}: awaited EMI not received yet`,
                body: `Early closure voucher ${r.voucher_no} (₹${round2(r.final_amount)}) is waiting for the EMI of ${expected.slice(0, 7)}.` });
        }
    }
    return out;
}
