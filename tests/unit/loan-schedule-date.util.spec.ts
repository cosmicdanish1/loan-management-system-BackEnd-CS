import { firstDueMonthFromDisbursement, installmentDueMonth } from '../../src/modules/loan/services-v2/loan-rb-schedule.util';

function yearMonth(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

describe('loan schedule date rules', () => {
    it('starts Slot 1 schedule in the month after disbursement when delay is one', () => {
        expect(yearMonth(firstDueMonthFromDisbursement(new Date(2026, 3, 12), 1))).toBe('2026-05-01');
    });

    it('starts Slot 2 schedule two months after disbursement when delay is two', () => {
        expect(yearMonth(firstDueMonthFromDisbursement(new Date(2026, 3, 12), 2))).toBe('2026-06-01');
    });

    it('counts later installments from the saved first due month', () => {
        const frozenFirstDueMonth = new Date(2026, 4, 1);

        expect(yearMonth(installmentDueMonth(frozenFirstDueMonth, 1))).toBe('2026-05-01');
        expect(yearMonth(installmentDueMonth(frozenFirstDueMonth, 2))).toBe('2026-06-01');
        expect(yearMonth(installmentDueMonth(frozenFirstDueMonth, 12))).toBe('2027-04-01');
    });

    it('normalizes month ends by calculating from the first of the due month', () => {
        expect(yearMonth(firstDueMonthFromDisbursement(new Date(2026, 0, 31), 1))).toBe('2026-02-01');
    });
});
