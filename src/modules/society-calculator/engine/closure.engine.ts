/**
 * Society Calculator (ES-525) - Phase 2: early-closure estimate (Method B, average principal) with a month-by-month NR register.
 * Uses the SAME shared functions as the real Early Closure screen: calculateConstantEmi (EMI sizing), computeApClosureInterest
 * (NR + AP interest) and computeTier (penalty). Rules mirrored from loan-repayment.service.ts calculateEarlyClosure:
 *  - the installment of the closure month is NOT overdue while the closure day is inside the grace period: it counts as a future one;
 *  - a closure quote never carries the same-month fee (Tier 1): only the monthly penalty (Tier 2) for months already late;
 *  - k = installments whose month has started (paid ones + unpaid NR ones); future = n - k;
 *  - every reported line is rounded by the rounding mode and the final amount is the sum of the rounded lines.
 */
import { BadRequestException } from '@nestjs/common';
import { applyLoanRounding, calculateConstantEmi, LOAN_ROUNDING_MODES, LoanRoundingMode } from '../../loan/services-v2/loan-rb-schedule.util';
import { computeApClosureInterest } from '../../loan/services-v2/loan-closure.util';
import { computeTier } from '../../loan/services-v2/loan-repayment.service';
import { daysInMonth, monthsBetween, round2, ymd } from './common';
import { Body, list, oneOf, optDate, optInt, optNum, reqDate, reqInt, reqNum } from './validate';
import { determineLoanSlot } from '../../loan/services-v2/loan-rb-schedule.util';
import { CalculatorRules, LoanTypeCode } from './rules';

export interface NrRow {
  month: string; // YYYY-MM
  dueDate: string;
  duePrincipal: number;
  paidPrincipal: number;
  unpaidPrincipal: number;
  interestDue: number;
  tier: 0 | 1 | 2;
  monthsOverdue: number;
  penalty: number;
  monthTotal: number;
}

/** A calendar date that falls in the wanted slot under the live slot window (the slot only needs a day of the month). */
export function representativeDate(slot: 1 | 2, rules: CalculatorRules): Date {
  for (let day = 1; day <= 28; day++) {
    const d = new Date(2026, 0, day);
    const s = determineLoanSlot(d, rules.slot.slot1DelayMonths, rules.slot.slot2DelayMonths, rules.slot.startDay, rules.slot.endDay);
    if (s.slot === slot) return d;
  }
  throw new BadRequestException(`No day of the month falls in Slot ${slot} with the current slot window.`);
}

export function computeClosure(b: Body, rules: CalculatorRules) {
  const loanAmt = reqNum(b, 'loanAmount', 'Loan amount', 0.01);
  const rate = reqNum(b, 'annualRate', 'Interest rate', 0, 36);
  const outstanding = reqNum(b, 'outstandingPrincipal', 'Latest outstanding principal', 0);
  if (outstanding > loanAmt) throw new BadRequestException('Outstanding principal cannot be more than the loan amount.');
  // The slot the loan was given in: typed as 1 or 2 (a real application date is still accepted)
  let appDate: Date;
  if (b.slot !== undefined && b.slot !== null && b.slot !== '') {
    const slot = reqInt(b, 'slot', 'Slot', 1, 2);
    appDate = representativeDate(slot as 1 | 2, rules);
  } else {
    appDate = reqDate(b, 'applicationDate', 'Application date');
  }
  const closureDate = reqDate(b, 'closureDate', 'Closure date');
  const mpIn = optNum(b, 'monthlyPrincipal', 'Monthly principal', 0, 0);
  const nIn = optInt(b, 'installments', 'Installments', 0, 0, 600);
  if (!(mpIn > 0) && !(nIn > 0)) throw new BadRequestException('Enter the monthly principal or the number of installments.');
  const n = nIn > 0 ? nIn : Math.min(600, Math.max(1, Math.round(loanAmt / mpIn)));
  const mode: LoanRoundingMode = (LOAN_ROUNDING_MODES as string[]).includes(String(b.roundingMode)) ? b.roundingMode : rules.roundingMode;
  const type = oneOf<LoanTypeCode>(b, 'loanType', 'Loan type', ['RLN', 'ALN', 'ELN'], 'RLN');
  const tr = rules.loanTypes[type];
  const grace = optInt(b, 'graceDay', 'Grace day', tr.graceDays, 0, 31);
  const penalRate = optNum(b, 'penalRate', 'Penalty rate', tr.penalRate, 0, 100);
  const adjustment = optNum(b, 'adjustment', 'Adjustment', 0, -999_999_999.99);
  const penaltyOn = b.penaltyEnabled === undefined ? rules.penaltyEnabled : b.penaltyEnabled === true || b.penaltyEnabled === 'true';

  const calc = calculateConstantEmi(loanAmt, rate, n, appDate, rules.slot.slot1DelayMonths, rules.slot.slot2DelayMonths, mode, rules.slot.startDay, rules.slot.endDay, 0);
  const mp = calc.monthlyPrincipal, mi = calc.monthlyInterestForEMI, instalAmt = calc.constantEMI;

  // ---- NR register: months from "NR from" to the closure month ----
  const nrFrom = optDate(b, 'nrFromDate', 'NR start date');
  const overrides = new Map<string, { p?: number; i?: number }>();
  for (const o of list(b, 'nrOverrides', 'NR month rows', 120)) {
    const month = String(o?.month ?? '');
    if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequestException('Each NR month must be YYYY-MM.');
    const p = o.paidPrincipal === undefined || o.paidPrincipal === '' || o.paidPrincipal === null ? undefined : Number(o.paidPrincipal);
    const i = o.paidInterest === undefined || o.paidInterest === '' || o.paidInterest === null ? undefined : Number(o.paidInterest);
    if ((p !== undefined && !(p >= 0)) || (i !== undefined && !(i >= 0))) throw new BadRequestException(`Paid amounts for ${month} must be 0 or more.`);
    overrides.set(month, { ...(p !== undefined ? { p } : {}), ...(i !== undefined ? { i } : {}) });
  }

  const rows: NrRow[] = [];
  let graceInstallment: string | null = null;
  if (nrFrom && nrFrom <= closureDate) {
    const span = monthsBetween(new Date(nrFrom.getFullYear(), nrFrom.getMonth(), 1), new Date(closureDate.getFullYear(), closureDate.getMonth(), 1));
    if (span > 120) throw new BadRequestException('The NR period is longer than 120 months.');
    for (let s = 0; s <= span; s++) {
      const due = new Date(nrFrom.getFullYear(), nrFrom.getMonth() + s, 1);
      const month = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}`;
      const dueDay = Math.max(1, Math.min(grace || 1, daysInMonth(due.getFullYear(), due.getMonth())));
      const dueDate = new Date(due.getFullYear(), due.getMonth(), dueDay);
      const isClosureMonth = s === span;
      const ov = overrides.get(month) ?? {};
      const paidP = Math.min(mp, ov.p ?? 0);
      const unpaidP = round2(Math.max(0, mp - paidP));
      const paidI = ov.i ?? (unpaidP <= 0 ? mi : 0);
      const interestDue = round2(Math.max(0, mi - paidI));
      const fullyPaid = unpaidP <= 0 && interestDue <= 0;
      // closure month still inside grace and unpaid: a future installment, not overdue
      if (isClosureMonth && !fullyPaid && grace > 0 && closureDate.getDate() <= grace) { graceInstallment = month; continue; }
      let tier: 0 | 1 | 2 = 0, monthsOverdue = 0, penalty = 0;
      if (!fullyPaid && penaltyOn) {
        const t = computeTier(unpaidP, false, dueDate, closureDate, grace, penalRate, tr.smPct, tr.smDiv, false);
        tier = t.tier; monthsOverdue = t.monthsOverdue; penalty = t.penalDue;
      }
      rows.push({
        month, dueDate: ymd(dueDate), duePrincipal: mp, paidPrincipal: round2(paidP), unpaidPrincipal: unpaidP, interestDue,
        tier, monthsOverdue, penalty, monthTotal: round2(unpaidP + interestDue + penalty),
      });
    }
  }

  const principalPaidTotal = round2(loanAmt - outstanding);
  const paidInRegister = round2(rows.reduce((s, r) => s + r.paidPrincipal, 0));
  const paidCount = Math.max(0, Math.floor((principalPaidTotal - paidInRegister) / mp + 1e-6));
  const nr = rows.filter((r) => r.unpaidPrincipal > 0 || r.interestDue > 0);
  const k = Math.min(n, paidCount + rows.length);

  const outstandingR = applyLoanRounding(outstanding, mode);
  const ap = computeApClosureInterest(loanAmt, n, instalAmt, rate, outstandingR, k, nr.map((r) => ({ principalDue: r.unpaidPrincipal, interestDue: r.interestDue })), mode);
  const penalInterest = applyLoanRounding(nr.reduce((s, r) => s + r.penalty, 0), mode);
  const principalAdj = optNum(b, 'principalAdjustment', 'Principal adjustment', 0, 0);
  const interestAdj = optNum(b, 'interestAdjustment', 'Interest adjustment', 0, 0);
  const finalClosure = applyLoanRounding(outstandingR + ap.closureInterest + penalInterest + adjustment - principalAdj - interestAdj, mode);

  // RD / Share adjustment (same rule as LoanEligibilityService.getRdShareClosureAdjustment): RD first, minimum kept in each
  const rd = optNum(b, 'rdBalance', 'RD balance', 0, 0), share = optNum(b, 'shareBalance', 'Share balance', 0, 0);
  const locked = optNum(b, 'rdLockedElsewhere', 'RD locked for other loans', 0, 0);
  const rdAvail = Math.max(0, round2(rd - locked - rules.rd.minBalanceAfterWithdrawal));
  const shareAvail = Math.max(0, round2(share - rules.eligibility.shareMinBalance));
  const applied = Math.min(finalClosure, round2(rdAvail + shareAvail));
  const fromRd = Math.min(applied, rdAvail), fromShare = round2(applied - fromRd);
  const payable = round2(finalClosure - applied);

  const remainingEmis = Math.max(0, n - paidCount);
  const remainingTotal = round2(remainingEmis * instalAmt);
  const interestSaved = Math.max(0, round2(remainingTotal - finalClosure));

  const tot = (f: (r: NrRow) => number) => round2(rows.reduce((s, r) => s + f(r), 0));
  const steps = [
    `EMI sized from the loan: monthly principal ${mp} + monthly interest ${mi} = ${instalAmt} (${n} installments, ${calc.slot === 1 ? 'Slot 1' : 'Slot 2'}).`,
    `Outstanding principal = latest ledger figure ${outstanding} (rounded ${mode}: ${outstandingR}). Paid installments before the register: ${paidCount}; installments started k = ${paidCount} + ${rows.length} = ${k}; future = ${n} - ${k} = ${ap.futureInstallmentCount}.`,
    graceInstallment ? `The ${graceInstallment} installment is still inside its grace period (closure day ${closureDate.getDate()} <= grace day ${grace}), so it is a future installment and carries no flat interest or penalty.` : 'No installment is inside its grace period on the closure date.',
    `NR interest = flat interest of the unpaid started installments = ${ap.nrInterest}.`,
    `Average remaining principal = (${round2(outstandingR - ap.nrPrincipal)} + ${mp}) / 2 = ${ap.averageRemainingPrincipal}; average RB interest = ${ap.averageRemainingPrincipal} x ${rate}/1200 = ${ap.averageRbInterest}.`,
    `AP interest = (${mi} - ${ap.averageRbInterest}) x ${ap.futureInstallmentCount} = ${ap.apInterest}; closure interest = NR ${ap.nrInterest} + AP ${ap.apInterest} = ${ap.closureInterest}.`,
    `Penalty (monthly, on unpaid principal; the same-month fee is never charged in a closure quote) = ${penalInterest}${penaltyOn ? '' : ' (penalty is switched off in Business Rules)'}.`,
    `Final closure amount = ${outstandingR} + ${ap.closureInterest} + ${penalInterest}${adjustment ? ` + adjustment ${adjustment}` : ''}${principalAdj + interestAdj ? ` - deductions ${principalAdj + interestAdj}` : ''} = ${finalClosure}.`,
  ];

  return {
    inputs: { loanAmount: loanAmt, annualRate: rate, installments: n, closureDate: ymd(closureDate), roundingMode: mode, graceDay: grace, penalRate, loanType: type },
    emi: { monthlyPrincipal: mp, monthlyInterest: mi, installment: instalAmt, slot: calc.slot, subSlot: calc.subSlot },
    outstandingPrincipal: outstandingR,
    paidInstallments: paidCount,
    startedInstallments: k,
    futureInstallments: ap.futureInstallmentCount,
    graceInstallment,
    register: rows,
    registerTotals: {
      duePrincipal: tot((r) => r.duePrincipal), paidPrincipal: tot((r) => r.paidPrincipal), unpaidPrincipal: tot((r) => r.unpaidPrincipal),
      interestDue: tot((r) => r.interestDue), penalty: tot((r) => r.penalty), monthTotal: tot((r) => r.monthTotal),
    },
    nrPrincipal: ap.nrPrincipal, nrInterest: ap.nrInterest, nrCount: nr.length,
    averageRemainingPrincipal: ap.averageRemainingPrincipal, averageRbInterest: ap.averageRbInterest,
    apInterest: ap.apInterest, closureInterest: ap.closureInterest, penalInterest,
    adjustment, principalAdjustment: principalAdj, interestAdjustment: interestAdj,
    finalClosureAmount: finalClosure,
    rdShare: { rdBalance: rd, shareBalance: share, rdAvailable: rdAvail, shareAvailable: shareAvail, appliedFromRdShare: applied, fromRd: round2(fromRd), fromShare, payableByMember: payable },
    remainingEmis, remainingEmiTotal: remainingTotal, interestSaved,
    steps,
    notes: penaltyOn ? [] : ['The tiered penalty is switched off in Business Rules, so no penalty is charged (same as the real Early Closure).'],
  };
}
