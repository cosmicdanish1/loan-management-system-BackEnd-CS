import { applyLoanRounding, LoanRoundingMode, round2 } from './loan-rb-schedule.util';

/** Minimal shape of an unpaid (NR) installment the closure maths needs. */
export interface NrInstallment { principalDue: number; interestDue: number }

/**
 * Method B (average-principal) closure interest - the society's manual closure worksheet and the app's ONLY closure method.
 * Pure: shared by LoanRepaymentService (Early Closure quote / execution) and the Society Calculator (ES-525), so both
 * always give the same figure. See docs/final-documentation/calculation_sop (section 11) for the formulas.
 */
export function computeApClosureInterest(
    loanAmt: number,
    noOfInstal: number,
    instalAmt: number,
    annualRate: number,
    outstandingPrincipal: number,
    k: number,
    unpaid: NrInstallment[],
    rounding: LoanRoundingMode,
    observedPrincipalEmi?: number,
): {
    nrPrincipal: number; nrInterest: number;
    futureInstallmentCount: number; averageRemainingPrincipal: number; averageRbInterest: number;
    apInterest: number; closureInterest: number;
} {
    const monthlyPrincipal = observedPrincipalEmi && observedPrincipalEmi > 0
        ? observedPrincipalEmi
        : (noOfInstal > 0 ? loanAmt / noOfInstal : 0);
    const totalInterestForEMI = instalAmt * noOfInstal - loanAmt;
    const monthlyInterestForEMI = observedPrincipalEmi && observedPrincipalEmi > 0
        ? Math.max(0, instalAmt - observedPrincipalEmi)
        : (noOfInstal > 0 ? totalInterestForEMI / noOfInstal : 0);
    const monthlyRate = annualRate / 1200;

    const nrPrincipal = round2(unpaid.reduce((sum, i) => sum + i.principalDue, 0));
    const nrInterest = round2(unpaid.reduce((sum, i) => sum + i.interestDue, 0));

    const futureInstallmentCount = Math.max(0, noOfInstal - k);
    let averageRemainingPrincipal = 0;
    let averageRbInterest = 0;
    let apInterest = 0;
    if (monthlyInterestForEMI > 0 && futureInstallmentCount > 0 && monthlyPrincipal > 0) {
        const futurePrincipal = outstandingPrincipal - nrPrincipal;
        const firstOpening = futurePrincipal;
        // The stable principal EMI is the AP endpoint, not a small residual final installment.
        averageRemainingPrincipal = round2((firstOpening + monthlyPrincipal) / 2);
        averageRbInterest = round2(averageRemainingPrincipal * monthlyRate);
        apInterest = applyLoanRounding((monthlyInterestForEMI - averageRbInterest) * futureInstallmentCount, rounding);
    }

    const closureInterest = applyLoanRounding(nrInterest + apInterest, rounding);
    return { nrPrincipal, nrInterest, futureInstallmentCount, averageRemainingPrincipal, averageRbInterest, apInterest, closureInterest };
}
