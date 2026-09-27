import { isSlotDelayPayroll, selectFirstRecurringPrincipal, ScheduleSeedRepayment } from '../../src/scripts/phase2/schedule-seed.util';

describe('selectFirstRecurringPrincipal', () => {
    const row = (date: string, principalAmount: number): ScheduleSeedRepayment => ({
        date,
        principalAmount,
        interestAmount: 0,
    });

    it('skips a one-off tiny residue and selects the first recurring principal', () => {
        const selected = selectFirstRecurringPrincipal([
            row('2021-01-16', 6.93),
            row('2021-02-16', 8884),
            row('2021-03-16', 8884),
            row('2021-04-16', 8884),
        ]);
        expect(selected?.principalAmount).toBe(8884);
    });

    it('does not infer a future term from a one-off payoff residue', () => {
        expect(selectFirstRecurringPrincipal([row('2021-03-12', 3.59)])).toBeUndefined();
    });

    it('uses the first recurring amount within this schedule window, not the later most-frequent amount', () => {
        const selected = selectFirstRecurringPrincipal([
            row('2024-08-10', 16667),
            row('2024-09-10', 19541),
            row('2024-10-10', 19541),
            row('2024-11-10', 19541),
            row('2025-01-10', 19541),
        ]);
        expect(selected?.principalAmount).toBe(19541);
    });

    it('requires recurrence across different calendar months', () => {
        expect(selectFirstRecurringPrincipal([
            row('2025-01-10', 500),
            row('2025-01-20', 500),
        ])).toBeUndefined();
    });
});

describe('isSlotDelayPayroll', () => {
    it('classifies pre-first-due payments at origination as predecessor payroll', () => {
        expect(isSlotDelayPayroll('2024-05-12 00:00:00', '2024-04-05', '2024-06-01')).toBe(true);
    });

    it('does not classify a payment in the first due month as predecessor payroll', () => {
        expect(isSlotDelayPayroll('2024-06-12', '2024-04-05', '2024-06-01')).toBe(false);
    });

    it('does not let a schedule boundary claim payroll after the next boundary', () => {
        expect(isSlotDelayPayroll('2024-05-12', '2024-04-05', '2024-06-01', '2024-05-01')).toBe(false);
    });
});
