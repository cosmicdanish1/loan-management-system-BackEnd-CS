/**
 * Society Calculator (ES-525) - Phase 4: member-money what-ifs (SOP sections 3, 7, 12, 18.6, 20, 21, 29).
 * Eligibility / withholding / Loan Against RD follow loan-eligibility.service.ts; the EMI of a consolidated or re-agreed loan
 * uses the real calculateConstantEmi.
 */
import { BadRequestException } from '@nestjs/common';
import { calculateConstantEmi, LOAN_ROUNDING_MODES, LoanRoundingMode } from '../../loan/services-v2/loan-rb-schedule.util';
import { round2, ymd } from './common';
import { Body, list, oneOf, optInt, optNum, reqDate, reqInt, reqNum, optDate } from './validate';
import { CalcResult, emptyResult } from './result';
import { CalculatorRules, LoanTypeCode } from './rules';

/** RD / Share requirement of a loan (RLN / ALN) and the net payout. */
function requirement(rules: CalculatorRules, loanAmount: number, existing: number, rd: number, share: number) {
  const e = rules.eligibility;
  const totalExposure = e.limitCalc === 'NEW_ONLY' ? loanAmount : existing + loanAmount;
  const requiredRd = totalExposure * (e.rdPct / 100), requiredShare = totalExposure * (e.sharePct / 100);
  const rdShortfall = Math.max(0, requiredRd - rd), shareShortfall = Math.max(0, requiredShare - share);
  const totalShortfall = e.shortfallMode === 'IGNORE' ? 0 : rdShortfall + shareShortfall;
  return { totalExposure, requiredRd, requiredShare, rdShortfall, shareShortfall, totalShortfall, withinLimit: totalExposure <= e.maxLimit };
}

export function computeEligibility(b: Body, rules: CalculatorRules): CalcResult {
  const type = oneOf<LoanTypeCode>(b, 'loanType', 'Loan type', ['RLN', 'ALN', 'ELN'], 'RLN');
  const amount = reqNum(b, 'loanAmount', 'Loan amount', 0.01);
  const rd = optNum(b, 'currentRd', 'RD balance', 0, -999_999_999.99), share = optNum(b, 'currentShare', 'Share value', 0, 0);
  const res = emptyResult();
  if (type === 'ELN') return computeLoanAgainstRd({ ...b, loanAmount: amount, totalRd: rd, lockedRd: b.lockedRd }, rules);
  const existing = optNum(b, 'existingOutstanding', 'Existing outstanding of this loan type', 0, 0);
  const r = requirement(rules, amount, existing, rd, share);
  const e = rules.eligibility;
  const eligible = r.withinLimit && !(e.shortfallMode === 'BLOCK' && r.totalShortfall > 0);
  const net = Math.max(0, amount - r.totalShortfall);
  res.kpis.push(
    { label: eligible ? 'Eligible' : 'Not eligible', value: eligible ? 'Yes' : 'No', kind: 'text', tone: eligible ? 'success' : 'danger', sub: r.withinLimit ? undefined : `above the ${e.maxLimit} limit` },
    { label: 'Net payout', value: net, kind: 'money', tone: 'info', sub: 'loan amount minus the withheld shortfall' },
    { label: 'RD shortfall', value: round2(r.rdShortfall), kind: 'money', tone: r.rdShortfall > 0 ? 'warning' : 'success' },
    { label: 'Share shortfall', value: round2(r.shareShortfall), kind: 'money', tone: r.shareShortfall > 0 ? 'warning' : 'success' },
  );
  res.steps.push(
    `Total exposure = ${existing} + ${amount} = ${round2(r.totalExposure)} (limit ${e.maxLimit}: ${r.withinLimit ? 'within' : 'ABOVE'}).`,
    `Required RD = ${round2(r.totalExposure)} x ${e.rdPct}% = ${round2(r.requiredRd)}; shortfall = max(0, ${round2(r.requiredRd)} - ${rd}) = ${round2(r.rdShortfall)}.`,
    `Required Share = ${round2(r.totalExposure)} x ${e.sharePct}% = ${round2(r.requiredShare)}; shortfall = max(0, ${round2(r.requiredShare)} - ${share}) = ${round2(r.shareShortfall)}.`,
    `Shortfall mode ${e.shortfallMode}: ${e.shortfallMode === 'DEDUCT' ? `${round2(r.totalShortfall)} is withheld from the payout and credited to the member's RD / Share, never added to the loan` : e.shortfallMode === 'BLOCK' ? 'a shortfall blocks the loan' : 'the shortfall is ignored'}.`,
  );
  return res;
}

export function computeLoanAgainstRd(b: Body, rules: CalculatorRules): CalcResult {
  const totalRd = reqNum(b, 'totalRd', 'Total RD', 0);
  const locked = optNum(b, 'lockedRd', 'RD already locked by other loans', 0, 0);
  const amount = optNum(b, 'loanAmount', 'Loan amount wanted', 0, 0);
  const { pct, ceiling } = rules.loanAgainstRd;
  const minBal = rules.rd.minBalanceAfterWithdrawal;
  const free = Math.max(0, round2(totalRd - locked));
  const byPercent = Math.max(0, totalRd * (pct / 100) - locked);
  const byFloor = free - minBal;
  const ceilingLeft = Math.max(0, ceiling - locked);
  const max = Math.max(0, Math.floor(Math.min(byPercent, byFloor, ceilingLeft)));
  const res = emptyResult();
  res.kpis.push(
    { label: 'Maximum Loan Against RD', value: max, kind: 'money', tone: max > 0 ? 'success' : 'danger' },
    { label: 'Free RD', value: free, kind: 'money', tone: 'info' },
    amount > 0 ? { label: amount <= max && max > 0 ? 'Wanted amount is allowed' : 'Wanted amount is too high', value: amount, kind: 'money', tone: amount <= max && max > 0 ? 'success' : 'danger' }
      : { label: 'Limit rule', value: pct, kind: 'pct', tone: 'warning', sub: `ceiling ${ceiling}` },
  );
  res.steps.push(
    `Free RD = ${totalRd} - ${locked} locked = ${free}.`,
    `By percent = ${totalRd} x ${pct}% - ${locked} = ${round2(byPercent)}.  By floor = free RD - minimum ${minBal} = ${round2(byFloor)}.  By ceiling = ${ceiling} - ${locked} = ${ceilingLeft}.`,
    `Maximum = floor(min of the three) = ${max}. Nothing is withheld; the RD is locked for the loan amount.`,
  );
  return res;
}

/** Consolidation: a new loan on top of an existing one of the same type. */
export function computeConsolidation(b: Body, rules: CalculatorRules): CalcResult {
  const type = oneOf<'RLN' | 'ALN'>(b, 'loanType', 'Loan type', ['RLN', 'ALN'], 'RLN');
  const existing = reqNum(b, 'existingBalance', 'Existing loan balance', 0);
  const sanction = reqNum(b, 'sanctionedAmount', 'New sanctioned amount', 0.01);
  const rate = reqNum(b, 'annualRate', 'Interest rate', 0, 36);
  const n = reqInt(b, 'installments', 'Installments', 1, 600);
  const appDate = reqDate(b, 'applicationDate', 'Application date');
  const oldInterest = optNum(b, 'oldClosureInterest', 'Closure interest of the old loan (NR + AP + penalty)', 0, 0);
  const rd = optNum(b, 'currentRd', 'RD balance', 0, -999_999_999.99), share = optNum(b, 'currentShare', 'Share value', 0, 0);
  const mode: LoanRoundingMode = (LOAN_ROUNDING_MODES as string[]).includes(String(b.roundingMode)) ? b.roundingMode : rules.roundingMode;
  const combined = round2(existing + sanction);
  const req = requirement(rules, sanction, existing, rd, share); // existing outstanding is added inside, as in the app
  const negative = round2(Math.max(0, -rd));
  // capDeductions order: negative RD, share shortfall, RD shortfall; never more than the fresh cash
  let remaining = round2(sanction);
  const dedu: Array<{ name: string; amount: number }> = [];
  for (const [name, amt] of [['Negative RD cleared (group insurance)', negative], ['Share shortfall', round2(req.shareShortfall)], ['RD shortfall', round2(req.rdShortfall)]] as Array<[string, number]>) {
    const a = round2(Math.min(amt, remaining));
    if (a > 0) { dedu.push({ name, amount: a }); remaining = round2(remaining - a); }
  }
  const shareRd = round2(dedu.reduce((s, d) => s + d.amount, 0));
  const withheld = round2(oldInterest + shareRd);
  const calc = calculateConstantEmi(combined, rate, n, appDate, rules.slot.slot1DelayMonths, rules.slot.slot2DelayMonths, mode, rules.slot.startDay, rules.slot.endDay, 0);
  const res = emptyResult();
  const blocked = withheld > sanction;
  res.kpis.push(
    { label: blocked ? 'Blocked: withholding is more than the new cash' : 'Net payout to member', value: blocked ? 'Blocked' : round2(sanction - withheld), kind: blocked ? 'text' : 'money', tone: blocked ? 'danger' : 'success' },
    { label: 'Combined principal', value: combined, kind: 'money', tone: 'info', sub: 'new loan amount on record' },
    { label: 'New monthly EMI', value: calc.constantEMI, kind: 'money', tone: 'warning', sub: `${n} installments, ${calc.slot === 1 ? 'Slot 1' : 'Slot 2'}` },
    { label: 'Total withheld', value: withheld, kind: 'money', tone: 'warning' },
  );
  res.steps.push(
    `Combined principal = ${existing} + ${sanction} = ${combined}; the new EMI is sized on this, not on the new slice alone.`,
    `Withheld from the fresh cash = old loan closure interest ${oldInterest} + RD / Share deductions ${shareRd} = ${withheld}. Net payout = ${sanction} - ${withheld} = ${round2(sanction - withheld)}.`,
    `EMI = monthly principal ${calc.monthlyPrincipal} + monthly interest ${calc.monthlyInterestForEMI} = ${calc.constantEMI}.`,
  );
  if (blocked) res.notes.push('The real disbursement refuses this: the withholding cannot be more than the fresh sanctioned amount.');
  res.tables.push({ title: 'Withholdings from the payout', columns: [{ key: 'name', label: 'Item' }, { key: 'amount', label: 'Amount', kind: 'money' }], rows: [{ name: 'Old loan closure interest (NR + AP + penalty)', amount: oldInterest }, ...dedu], totals: { amount: withheld } });
  void type;
  return res;
}

/** Re-agreement: new EMI on the outstanding principal, carrying the old loan's AP interest. */
export function computeReagreement(b: Body, rules: CalculatorRules): CalcResult {
  const outstanding = reqNum(b, 'outstandingPrincipal', 'Outstanding principal', 0.01);
  const ap = optNum(b, 'apInterest', 'AP interest carried', 0, 0);
  const nr = optNum(b, 'nrInterest', 'NR interest to collect now', 0, 0);
  const pen = optNum(b, 'penalty', 'Penalty to collect now', 0, 0);
  const rate = reqNum(b, 'annualRate', 'New interest rate', 0, 36);
  const n = reqInt(b, 'installments', 'New number of installments', 1, 600);
  const appDate = reqDate(b, 'applicationDate', 'Application date');
  const mode: LoanRoundingMode = (LOAN_ROUNDING_MODES as string[]).includes(String(b.roundingMode)) ? b.roundingMode : rules.roundingMode;
  const c = calculateConstantEmi(outstanding, rate, n, appDate, rules.slot.slot1DelayMonths, rules.slot.slot2DelayMonths, mode, rules.slot.startDay, rules.slot.endDay, ap);
  const res = emptyResult();
  res.kpis.push(
    { label: 'New monthly EMI', value: c.constantEMI, kind: 'money', tone: 'info', sub: `${c.monthlyPrincipal} + ${c.monthlyInterestForEMI}` },
    { label: 'Collect now (NR + penalty)', value: round2(nr + pen), kind: 'money', tone: 'warning', sub: 'no payout in a re-agreement' },
    { label: 'Total payable', value: round2(c.constantEMI * n), kind: 'money', tone: 'success' },
    { label: 'Interest carried', value: c.carriedInterest, kind: 'money', tone: 'danger' },
  );
  res.steps.push(
    `The new agreement is priced like a new loan on the outstanding principal ${outstanding}: monthly principal ${c.monthlyPrincipal}.`,
    `Total interest = RB ${c.totalRBInterest} + delay ${c.delayInterest} + carried AP ${c.carriedInterest} = ${c.totalInterestForEMI}; / ${n} = ${round2(c.totalInterestForEMI / n)}; rounded (${mode}) = ${c.monthlyInterestForEMI}.`,
    `EMI = ${c.monthlyPrincipal} + ${c.monthlyInterestForEMI} = ${c.constantEMI}.`,
  );
  return res;
}

export function computeDividend(b: Body): CalcResult {
  const rate = reqNum(b, 'dividendRate', 'Dividend rate (%)', 0, 100, true);
  const rows = list(b, 'balances', 'Month-end share balances', 12);
  if (!rows.length) throw new BadRequestException('Enter at least one month-end share balance.');
  const bal = rows.map((r, i) => ({ month: String(r?.month || `Month ${i + 1}`), balance: reqNum(r, 'balance', `Balance of row ${i + 1}`, 0) }));
  const total = round2(bal.reduce((s, r) => s + r.balance, 0));
  const dividend = round2((total * rate) / 1200);
  const res = emptyResult();
  res.kpis.push(
    { label: 'Dividend', value: dividend, kind: 'money', tone: 'success' },
    { label: 'Total product', value: total, kind: 'money', tone: 'info', sub: `${bal.length} month-end balances` },
    { label: 'Share value after credit', value: round2(bal[bal.length - 1]!.balance + dividend), kind: 'money', tone: 'info', sub: 'last balance + dividend' },
    { label: 'On average balance', value: round2(total / bal.length), kind: 'money', tone: 'warning' },
  );
  res.steps.push(
    `Total product = sum of the ${bal.length} month-end share balances = ${total}.`,
    `Dividend = total product x rate / 1200 = ${total} x ${rate} / 1200 = ${dividend}.`,
  );
  if (bal.length < 12) res.notes.push(`Only ${bal.length} of 12 months entered: the real calculation does not count a month without a snapshot, so the dividend is understated.`);
  res.tables.push({ title: 'Month-end share balances', columns: [{ key: 'month', label: 'Month' }, { key: 'balance', label: 'Share balance', kind: 'money' }], rows: bal, totals: { balance: total } });
  return res;
}

export function computeInsurance(b: Body): CalcResult {
  const lump = reqNum(b, 'lumpSum', 'Lump sum for the year', 0.01);
  const members = reqInt(b, 'activeMembers', 'Number of eligible active members', 1, 1_000_000);
  const fyStart = reqDate(b, 'fyStartDate', 'Financial year start');
  const fyEnd = new Date(fyStart.getFullYear() + 1, fyStart.getMonth(), 0);
  const join = optDate(b, 'joinDate', 'Member joining date');
  const rd = optNum(b, 'rdBalance', 'RD balance of the member', 0, -999_999_999.99);
  const per = lump / members;
  let months = 12;
  if (join) {
    if (join < fyStart) months = 12;
    else if (join > fyEnd) months = 0;
    else months = 12 - ((join.getFullYear() * 12 + join.getMonth()) - (fyStart.getFullYear() * 12 + fyStart.getMonth()));
  }
  const calc = round2((per * months) / 12);
  const charge = Math.ceil(calc);
  const res = emptyResult();
  res.kpis.push(
    { label: 'Charge for this member', value: charge, kind: 'money', tone: months > 0 ? 'success' : 'warning', sub: 'rounded UP to the next rupee' },
    { label: 'Yearly share per member', value: round2(per), kind: 'money', tone: 'info' },
    { label: 'Months charged', value: months, kind: 'int', tone: 'info', sub: join ? `joined ${ymd(join)}` : 'full year' },
    { label: 'RD after deduction', value: round2(rd - charge), kind: 'money', tone: rd - charge < 0 ? 'danger' : 'success', sub: rd - charge < 0 ? 'goes negative (recovered later)' : undefined },
  );
  res.steps.push(
    `Yearly share = ${lump} / ${members} = ${round2(per)}.`,
    `Months = ${months}${join ? ' (the joining month is counted)' : ''}; pro-rata = ${round2(per)} x ${months}/12 = ${calc}; charge = ceil(${calc}) = ${charge}.`,
    'The amount is debited from the member RD (which may go negative on purpose); a negative RD is cleared first from the next loan payout.',
  );
  return res;
}

/** Saakh score (admin/services/saakh-score.service.ts), computed from typed figures instead of the database. */
export function computeSaakh(b: Body): CalcResult {
  const hasLoans = oneOf(b, 'hasLoanHistory', 'Has loan history', ['YES', 'NO'] as const, 'YES') === 'YES';
  const avgRepaid = optNum(b, 'avgRepaidPct', 'Average repaid % over all loans', 100, 0, 100);
  const susp = optNum(b, 'suspenseBalance', 'Suspense balance', 0, 0);
  const penaltyLoans = optInt(b, 'loansWithPenalty', 'Active loans with a penalty rate', 0, 0, 100);
  const activeLoans = optInt(b, 'activeLoans', 'Active loans', 0, 0, 100);
  const share = optNum(b, 'shareCapital', 'Share capital', 0, 0), cd = optNum(b, 'cdBalance', 'CD / RD balance', 0, 0);
  const tenure = optInt(b, 'tenureYears', 'Years as a member', 0, 0, 80);
  const guarantorFor = optInt(b, 'guarantorFor', 'Number of loans guaranteed', 0, 0, 100);
  const guarantorClear = oneOf(b, 'guaranteedLoansClear', 'Guaranteed loans all cleared', ['YES', 'NO'] as const, 'YES') === 'YES';
  let f1 = !hasLoans ? 2.0 : avgRepaid >= 90 ? 3.0 : avgRepaid >= 70 ? 2.5 : avgRepaid >= 50 ? 2.0 : avgRepaid >= 30 ? 1.2 : 0.5;
  if (susp > 0) f1 = Math.max(0, f1 - 0.5);
  let f2 = 2.0 - penaltyLoans * 0.5; if (susp > 0) f2 -= 0.3; f2 = Math.min(2, Math.max(0, f2));
  const f3 = activeLoans === 0 ? 1.5 : activeLoans === 1 ? 1.2 : activeLoans === 2 ? 0.8 : 0.3;
  const sv = share + cd;
  const f4 = sv >= 500000 ? 1.5 : sv >= 300000 ? 1.2 : sv >= 100000 ? 0.9 : sv >= 50000 ? 0.6 : sv >= 10000 ? 0.3 : 0.1;
  const f5 = tenure >= 10 ? 1.0 : tenure >= 5 ? 0.8 : tenure >= 3 ? 0.6 : tenure >= 1 ? 0.4 : 0.2;
  const f6 = guarantorFor === 0 ? 0.7 : guarantorClear ? 1.0 : 0.3;
  const total = parseFloat((f1 + f2 + f3 + f4 + f5 + f6).toFixed(1));
  const tier = total >= 9 ? 'Platinum' : total >= 7 ? 'Gold' : total >= 5 ? 'Silver' : total >= 3 ? 'Bronze' : 'Critical';
  let recommended = 0;
  if (total >= 7) recommended = Math.round(Math.min((sv * 3 + share) * (total / 10), 1_000_000) / 1000) * 1000;
  else if (total >= 5) recommended = Math.round(Math.min(sv, 300000) / 1000) * 1000;
  const res = emptyResult();
  res.kpis.push(
    { label: 'Saakh score', value: total, kind: 'num', tone: total >= 7 ? 'success' : total >= 5 ? 'warning' : 'danger', sub: `out of 10 - ${tier}` },
    { label: 'Eligibility', value: total >= 7 ? 'Yes' : total >= 5 ? 'Conditional' : 'No', kind: 'text', tone: total >= 7 ? 'success' : total >= 5 ? 'warning' : 'danger' },
    { label: 'Recommended amount', value: recommended, kind: 'money', tone: 'info' },
    { label: 'Savings + share', value: sv, kind: 'money', tone: 'info' },
  );
  res.tables.push({
    title: 'Six factors', columns: [{ key: 'name', label: 'Factor' }, { key: 'score', label: 'Score', kind: 'num' }, { key: 'max', label: 'Out of', kind: 'num' }],
    rows: [
      { name: 'Repayment punctuality', score: f1, max: 3 }, { name: 'Penalty history', score: round2(f2), max: 2 }, { name: 'Active loan load', score: f3, max: 1.5 },
      { name: 'Savings and share capital', score: f4, max: 1.5 }, { name: 'Membership tenure', score: f5, max: 1 }, { name: 'Guarantor reliability', score: f6, max: 1 },
    ],
    totals: { score: total, max: 10 },
  });
  res.steps.push('Score = sum of the six factors rounded to one decimal. Tier: 9+ Platinum, 7+ Gold, 5+ Silver, 3+ Bronze, else Critical. 7 or more: recommended amount = min((savings x 3 + share) x score/10, 10,00,000) rounded to 1,000; 5 to 7: min(savings, 3,00,000) rounded to 1,000.');
  return res;
}
