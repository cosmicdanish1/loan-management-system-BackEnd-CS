import { calculateConstantEmi } from '../../src/modules/loan/services-v2/loan-rb-schedule.util';
import { buildAgreementLayout, AgreementData } from '../../src/modules/loan/services-v2/reagreement/reagreement-agreement.layout';

// Application dates: day 10 -> Slot 2 (2 months delay); day 26 -> Slot 1 late month (first EMI 2 months out, interest 1 month).
const SLOT2_DATE = new Date(2026, 9, 10);
const SLOT1_DATE = new Date(2026, 9, 3); // early month Slot 1 (1 month delay)

describe('re-agreement EMI (new-loan formula + carried closure interest)', () => {
    it('a new loan (no carried interest) is unchanged: 3,00,000 / 60 / 12% / Slot 1 -> EMI 6,575', () => {
        const r = calculateConstantEmi(300000, 12, 60, SLOT1_DATE, 1, 2, 'NEAREST');
        expect(r.monthlyPrincipal).toBe(5000);
        expect(r.monthlyInterestForEMI).toBe(1575);
        expect(r.constantEMI).toBe(6575);
        expect(r.carriedInterest).toBe(0);
    });

    // Worked examples from RE_AGREEMENT_MASTER.md section 2b: Rs 1,80,000 outstanding, carried AP Rs 23,400.
    it.each([
        // n, rate, date, expected monthly interest, expected EMI
        [60, 12, SLOT1_DATE, 1335, 4335],
        [60, 12, SLOT2_DATE, 1365, 4365],
        [24, 12, SLOT1_DATE, 1988, 9488],
        [36, 9, SLOT1_DATE, 1381, 6381],
    ])('carried 23,400 over %i months at %i%%', (n, rate, date, interest, emi) => {
        const r = calculateConstantEmi(180000, rate as number, n as number, date as Date, 1, 2, 'NEAREST', 25, 5, 23400);
        expect(r.carriedInterest).toBe(23400);
        expect(r.monthlyInterestForEMI).toBe(interest);
        expect(r.constantEMI).toBe(emi);
    });

    it('arrears case: principal 1,90,000 over 60 months, Slot 1 -> EMI 4,553.67', () => {
        const r = calculateConstantEmi(190000, 12, 60, SLOT1_DATE, 1, 2, 'NEAREST', 25, 5, 23400);
        expect(r.monthlyInterestForEMI).toBe(1387);
        expect(r.constantEMI).toBe(4553.67);
    });

    it('negative carried interest is ignored (never reduces the interest)', () => {
        const withNeg = calculateConstantEmi(180000, 12, 36, SLOT1_DATE, 1, 2, 'NEAREST', 25, 5, -500);
        const without = calculateConstantEmi(180000, 12, 36, SLOT1_DATE, 1, 2, 'NEAREST', 25, 5, 0);
        expect(withNeg.constantEMI).toBe(without.constantEMI);
    });
});

describe('re-agreement document layout', () => {
    const data: AgreementData = {
        status: 'FINAL', reagreementNo: 'RA00001', issueNo: 1, issuedAt: '2026-10-12T10:00:00.000Z',
        applicationDate: '2026-10-12', effectiveDate: '2026-10-12', firstDueMonth: '2026-12-01', voucherNo: 'VCH042', reason: 'Lower EMI',
        member: { mbno: '610020500', name: 'TEST MEMBER' }, sureties: [{ mbno: '610020501', name: 'SURETY ONE' }],
        loanType: 'RLN', loanTypeName: 'REGULAR LOAN', oldCaseNo: '18445', newCaseNo: '21001',
        old: { rate: 12, installments: 60, monthlyPrincipal: 5000, monthlyInterest: 1575, monthlyInstallment: 6575, paidInstallments: 24 },
        neu: { rate: 12, installments: 60, monthlyPrincipal: 3000, monthlyInterest: 1335, monthlyInstallment: 4335, slot: 1, delayMonths: 2, delayInterest: 1800, totalRbInterest: 54900, totalInterestForEmi: 80100 },
        outstandingPrincipal: 180000, nrInterest: 0, penaltyCollected: 0, carriedInterest: 23400, collectedNow: 0,
        oldRemainingPayable: 236700, newTotalPayable: 260100,
    };

    it('is deterministic and fits the 90-column page', () => {
        const a = buildAgreementLayout(data), b = buildAgreementLayout(data);
        expect(a.lines).toEqual(b.lines);
        expect(Math.max(...a.lines.map(l => l.length))).toBeLessThanOrEqual(90);
    });

    it('shows both agreements, the carried interest and the declaration', () => {
        const text = buildAgreementLayout(data).lines.join('\n');
        expect(text).toContain('LOAN RE-AGREEMENT');
        expect(text).toContain('Old Agreement');
        expect(text).toContain('4,335.00');
        expect(text).toContain('23,400.00');
        expect(text).toContain('loan case 18445 shall be carried into loan case 21001');
    });

    it('marks a draft clearly and reserves signature bands for borrower, surety and society', () => {
        const l = buildAgreementLayout({ ...data, status: 'DRAFT' });
        expect(l.lines.join('\n')).toContain('DRAFT COPY');
        expect(l.signatureSlots.map(s => s.key)).toEqual(['BORROWER', 'SURETY1', 'SOCIETY']);
    });
});
