// Pure-rule check of the old-EMI / new-EMI "check this" flags (no database) using the
// numbers from the worked examples: Member A (old 10,000+450, new 7,000+455),
// Member B (old 10,000+650, new 8,333.33+625), Member C (same total, different split),
// Member D (old and new identical 8,000+500).
import { LoanPaymentFlagService, WatchedLoan, EvaluateInput } from '../modules/loan/services-v2/loan-payment-flag.service';

const w = (oP: number, oI: number, nP: number, nI: number): WatchedLoan => ({
    mbno: '1', loancaseno: '1', loantype: 'RLN', oldPrincipal: oP, oldInterest: oI, newPrincipal: nP, newInterest: nI,
    startDate: new Date(2025, 5, 3), watchUntil: new Date(2025, 6, 3),
});
const A = w(10000, 450, 7000, 455);
const B = w(10000, 650, 8333.33, 625);
const C = w(10000, 450, 9500, 950);
const D = w(8000, 500, 8000, 500);

let failed = 0;
function check(label: string, input: Partial<EvaluateInput> & { watched: WatchedLoan; total: number }, expected: string | null) {
    const full: EvaluateInput = { phase: 'IN_WINDOW', priorOldSized: 0, tolerance: 10, ...input };
    const got = LoanPaymentFlagService.evaluate(full);
    const ok = got === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  -> ${got ?? 'no flag'}${ok ? '' : `  (expected ${expected ?? 'no flag'})`}`);
}

check('A normal old EMI in the wait (10,450)', { watched: A, total: 10450 }, null);
check('A normal new EMI (7,455)', { watched: A, total: 7455 }, null);
check('A 50 away (10,400) with default range 10', { watched: A, total: 10400 }, null);
check('A 50 away (10,400) with range 100', { watched: A, total: 10400, tolerance: 100 }, 'NEAR_OLD_EMI');
check('A 8 away (10,442) with default range 10', { watched: A, total: 10442 }, 'NEAR_OLD_EMI');
check('A exactly 10 away (10,440)', { watched: A, total: 10440 }, 'NEAR_OLD_EMI');
check('A 11 away (10,439) with range 10', { watched: A, total: 10439 }, null);
check('A 11 away (10,439) with range 20', { watched: A, total: 10439, tolerance: 20 }, 'NEAR_OLD_EMI');
check('A range 0 turns near-check off (10,400)', { watched: A, total: 10400, tolerance: 0 }, null);
check('A unrelated amount (9,000)', { watched: A, total: 9000 }, null);
check('A second old-EMI-sized payment (10,450 again)', { watched: A, total: 10450, priorOldSized: 1 }, 'SECOND_OLD_EMI');
check('A old EMI after the wait (10,450)', { watched: A, total: 10450, phase: 'AFTER_WINDOW' }, 'OLD_EMI_AFTER_WINDOW');
check('A new EMI after the wait (7,455)', { watched: A, total: 7455, phase: 'AFTER_WINDOW' }, null);
check('A near-old after the wait (10,400) is not flagged', { watched: A, total: 10400, phase: 'AFTER_WINDOW' }, null);
check('B old + new together (19,608.33)', { watched: B, total: 19608.33 }, 'COMBINED_EMI');
check('B old + new together after the wait', { watched: B, total: 19608.33, phase: 'AFTER_WINDOW' }, 'COMBINED_EMI');
check('B normal old EMI #1 (10,650)', { watched: B, total: 10650 }, null);
check('B old EMI #2 is a second one (10,650)', { watched: B, total: 10650, priorOldSized: 1 }, 'SECOND_OLD_EMI');
check('C same total, no split known (10,450)', { watched: C, total: 10450 }, 'IDENTICAL_EMI');
check('C same total, split says OLD (10,000 + 450)', { watched: C, total: 10450, principal: 10000, interest: 450 }, null);
check('C same total, split says NEW (9,500 + 950)', { watched: C, total: 10450, principal: 9500, interest: 950 }, null);
check('C same total, split matches neither (9,000 + 1,450)', { watched: C, total: 10450, principal: 9000, interest: 1450 }, 'IDENTICAL_EMI');
check('D identical old and new (8,500)', { watched: D, total: 8500 }, 'IDENTICAL_EMI');
check('D identical, split cannot tell them apart', { watched: D, total: 8500, principal: 8000, interest: 500 }, 'IDENTICAL_EMI');
check('D identical but an old deduction was already counted', { watched: D, total: 8500, priorOldSized: 1 }, 'SECOND_OLD_EMI');
check('D identical after the wait is just the new EMI', { watched: D, total: 8500, phase: 'AFTER_WINDOW' }, null);

console.log(failed === 0 ? '\nALL FLAG RULE CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
