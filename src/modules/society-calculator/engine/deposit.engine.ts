/**
 * Society Calculator (ES-525) - Phase 3: SB, FD and RD interest what-ifs (SOP sections 15, 16, 18).
 * RD uses the real pure functions of the RD system (rd-installment-interest-calculator, rd-opening-balance-interest).
 * SB / FD follow interest.service.ts (calculateMemberInterest / calculateFDInterest, private there: same formulas, kept side by side).
 */
import { BadRequestException } from '@nestjs/common';
import { calculateRdInstallmentInterest } from '../../rd/rd-installment-interest-calculator';
import { calculateOpeningBalanceInterest } from '../../rd/rd-opening-balance-interest';
import { remainingMonthsInFinancialYear } from '../../rd/rd-interest-chart';
import { parseYmd, round2, ymd } from './common';
import { Body, list, oneOf, optNum, reqDate, reqNum } from './validate';
import { CalcResult, emptyResult } from './result';
import { CalculatorRules } from './rules';

const DAY_MS = 86_400_000;

/** SB: daily product method. Every calendar day from..to (both included) earns on its closing balance. */
export function computeSb(b: Body): CalcResult {
  const opening = reqNum(b, 'openingBalance', 'Opening balance', -999_999_999.99);
  const rate = reqNum(b, 'annualRate', 'Interest rate', 0, 50);
  const from = reqDate(b, 'fromDate', 'From date');
  const to = reqDate(b, 'toDate', 'To date');
  if (to < from) throw new BadRequestException('To date must not be before the from date.');
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > 366) throw new BadRequestException('The period cannot be longer than 366 days.');
  const txns = list(b, 'transactions', 'Transactions', 400).map((t, i) => {
    const type = oneOf(t, 'type', `Transaction ${i + 1} type`, ['CR', 'DR'] as const);
    const amount = reqNum(t, 'amount', `Transaction ${i + 1} amount`, 0.01);
    const date = parseYmd(String(t?.date ?? ''), `Transaction ${i + 1} date`);
    return { date, type, amount };
  }).sort((x, y) => x.date.getTime() - y.date.getTime());

  let bal = opening, sum = 0, ti = 0, totalCr = 0, totalDr = 0;
  const segs: Array<{ from: string; to: string; balance: number; days: number; product: number }> = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d);
    while (ti < txns.length && txns[ti]!.date.getTime() <= day.getTime()) {
      const t = txns[ti]!;
      if (t.type === 'CR') { bal += t.amount; totalCr += t.amount; } else { bal -= t.amount; totalDr += t.amount; }
      ti++;
    }
    sum += bal;
    const last = segs[segs.length - 1];
    if (last && last.balance === bal) { last.to = ymd(day); last.days++; last.product = round2(last.balance * last.days); }
    else segs.push({ from: ymd(day), to: ymd(day), balance: round2(bal), days: 1, product: round2(bal) });
  }
  const dailyRate = rate / 100 / 365;
  const interest = Math.max(0, round2(sum * dailyRate));
  const res = emptyResult();
  res.kpis.push(
    { label: 'Interest', value: interest, kind: 'money', tone: 'success' },
    { label: 'Average balance', value: round2(sum / days), kind: 'money', tone: 'info', sub: `${days} days` },
    { label: 'Closing balance + interest', value: round2(bal + interest), kind: 'money', tone: 'info' },
    { label: 'Sum of daily balances', value: round2(sum), kind: 'money', tone: 'warning' },
  );
  res.steps.push(
    `Daily rate = ${rate} / 100 / 365 = ${dailyRate.toFixed(8)}. A transaction counts on its own day.`,
    `Interest = max(0, round2(sum of daily balances ${round2(sum)} x ${dailyRate.toFixed(8)})) = ${interest}. An overdrawn account never earns negative interest.`,
  );
  res.tables.push({
    title: 'Balance periods', columns: [{ key: 'from', label: 'From' }, { key: 'to', label: 'To' }, { key: 'days', label: 'Days', kind: 'int' }, { key: 'balance', label: 'Balance', kind: 'money' }, { key: 'product', label: 'Balance x days', kind: 'money' }],
    rows: segs, totals: { days, product: round2(sum) },
  });
  res.notes.push(`Deposits ${round2(totalCr)} and withdrawals ${round2(totalDr)} in the period.`);
  return res;
}

/** FD: legacy years / months / days formula (30-day months, 365-day years). FD behaviour is officially on hold. */
export function computeFd(b: Body): CalcResult {
  const principal = reqNum(b, 'principal', 'FD amount', 0.01);
  const rate = reqNum(b, 'annualRate', 'Interest rate', 0, 50);
  const dep = reqDate(b, 'depositDate', 'Deposit date');
  const calc = reqDate(b, 'calcDate', 'Calculate up to');
  const paid = optNum(b, 'alreadyPaid', 'Interest already paid', 0, 0);
  const totalDays = Math.ceil((calc.getTime() - dep.getTime()) / DAY_MS);
  if (totalDays <= 0) throw new BadRequestException('The calculation date must be after the deposit date.');
  const years = Math.floor(totalDays / 365);
  const remain = totalDays - years * 365;
  const months = Math.floor(remain / 30);
  const days = remain - months * 30;
  const yi = (principal * rate * years) / 100, mi = (principal * rate * months) / 1200, di = (principal * rate * days) / 36500;
  const interest = round2(yi + mi + di);
  const net = round2(Math.max(interest - paid, 0));
  const res = emptyResult();
  res.kpis.push(
    { label: 'Interest', value: interest, kind: 'money', tone: 'success', sub: `${years} y ${months} m ${days} d` },
    { label: 'Net interest (after already paid)', value: net, kind: 'money', tone: 'info' },
    { label: 'Principal + interest', value: round2(principal + interest), kind: 'money', tone: 'info' },
    { label: 'Total days', value: totalDays, kind: 'int', tone: 'warning' },
  );
  res.steps.push(
    `Total days = ${totalDays}: years = floor(${totalDays}/365) = ${years}; remaining ${remain} days = ${months} month(s) of 30 days + ${days} day(s).`,
    `Years part = ${principal} x ${rate} x ${years} / 100 = ${round2(yi)}.  Months part = ${principal} x ${rate} x ${months} / 1200 = ${round2(mi)}.  Days part = ${principal} x ${rate} x ${days} / 36500 = ${round2(di)}.`,
    `Interest = ${interest}; net = max(interest - already paid ${paid}, 0) = ${net}.`,
  );
  res.notes.push('Simple interest, no compounding. Fixed Deposit behaviour is on hold in the application: this is the legacy formula currently coded.');
  return res;
}

/** RD financial year: installment interest (chart formula) + opening-balance interest (balance x months held). */
export function computeRd(b: Body, rules: CalculatorRules): CalcResult {
  const monthly = reqNum(b, 'monthlyAmount', 'Monthly RD amount', 0.01);
  const rate = optNum(b, 'annualRate', 'Interest rate', rules.rd.rate, 0, 50);
  const fyStart = reqDate(b, 'fyStartDate', 'Financial year start');
  const fyEnd = new Date(fyStart.getFullYear() + 1, fyStart.getMonth(), 0); // last day of the 12th month
  const eligible = oneOf(b, 'fullInterestEligible', 'Eligible for full interest', ['YES', 'NO'] as const, 'YES') === 'YES';

  const given = list(b, 'installments', 'Installments', 12);
  const inst = (given.length ? given : Array.from({ length: 12 }, (_, i) => ({ status: 'ON_TIME', dueMonth: ymd(new Date(fyStart.getFullYear(), fyStart.getMonth() + i, 1)).slice(0, 7) })))
    .map((r: any, i: number) => {
      const status = oneOf(r, 'status', `Installment ${i + 1} status`, ['ON_TIME', 'LATE', 'UNPAID'] as const, 'ON_TIME');
      const dm = String(r?.dueMonth ?? '');
      if (!/^\d{4}-\d{2}$/.test(dm)) throw new BadRequestException(`Installment ${i + 1}: due month must be YYYY-MM.`);
      const dueDate = parseYmd(`${dm}-01`, `Installment ${i + 1} due month`);
      const paidDate = status === 'UNPAID' ? null : status === 'LATE' ? reqDate(r, 'paidDate', `Installment ${i + 1} paid date`) : dueDate;
      const amount = optNum(r, 'amount', `Installment ${i + 1} amount`, monthly, 0.01);
      return { dueMonth: dm, status, dueDate, paidDate, amount };
    });
  const paidRows = inst.filter((r) => r.paidDate);
  const inter = calculateRdInstallmentInterest(
    paidRows.map((r) => ({ dueDate: r.dueDate, paidDate: r.paidDate as Date, paidAmount: r.amount })), rate, eligible, fyEnd,
  );

  const events = list(b, 'balanceEvents', 'Balance events', 60).map((e, i) => ({
    eventDate: reqDate(e, 'date', `Balance event ${i + 1} date`),
    eventType: oneOf(e, 'type', `Balance event ${i + 1} type`, ['OPENING', 'WITHDRAWAL', 'LOAN_ADDITION', 'OTHER'] as const, 'OPENING'),
    resultingBalance: reqNum(e, 'balance', `Balance event ${i + 1} balance after the event`, 0),
  }));
  const opening = calculateOpeningBalanceInterest(events, rate, fyEnd);
  const total = round2(inter.totalInterest + opening.totalInterest);

  const res = emptyResult();
  res.kpis.push(
    { label: 'Total interest credited', value: total, kind: 'money', tone: 'success' },
    { label: 'Installment interest', value: inter.totalInterest, kind: 'money', tone: 'info', sub: eligible ? 'as if every installment was on time' : 'honest months from the paid date' },
    { label: 'Opening-balance interest', value: opening.totalInterest, kind: 'money', tone: 'info' },
    { label: 'Rate', value: rate, kind: 'pct', tone: 'warning', sub: 'Business Rules' },
  );
  res.steps.push(
    `Installment interest = amount x ${rate}/100 x remaining months/12 (April = 12 months ... March = 1). Only paid installments earn.`,
    eligible ? 'Eligible member: a late installment uses the larger of the due-month and paid-month remaining months (the "as if on time" bonus).'
      : 'Not eligible: a late installment uses the remaining months from the month it was really paid (0 if paid after the year end).',
    `Opening-balance interest = balance x ${rate}/100 x months held/12 per period. A withdrawal counts from its own month, a loan addition from the next month.`,
  );
  res.tables.push({
    title: 'Installment interest',
    columns: [{ key: 'due', label: 'Due month' }, { key: 'paid', label: 'Paid on' }, { key: 'rem', label: 'Remaining months', kind: 'int' }, { key: 'amount', label: 'Amount', kind: 'money' }, { key: 'interest', label: 'Interest', kind: 'money' }],
    rows: inter.rows.map((r) => ({ due: ymd(r.dueDate).slice(0, 7), paid: ymd(r.paidDate), rem: r.remainingMonthsUsed, amount: r.paidAmount, interest: r.interest })),
    totals: { interest: inter.totalInterest },
  });
  const unpaid = inst.filter((r) => !r.paidDate);
  if (unpaid.length) res.notes.push(`${unpaid.length} unpaid installment(s) earn nothing (${unpaid.map((r) => r.dueMonth).join(', ')}).`);
  if (opening.periods.length) {
    res.tables.push({
      title: 'Opening-balance periods',
      columns: [{ key: 'from', label: 'From' }, { key: 'to', label: 'To' }, { key: 'months', label: 'Months held', kind: 'int' }, { key: 'balance', label: 'Balance', kind: 'money' }, { key: 'interest', label: 'Interest', kind: 'money' }],
      rows: opening.periods.map((p) => ({ from: ymd(p.fromDate), to: ymd(p.toDate), months: p.monthsHeld, balance: p.balance, interest: p.interest })),
      totals: { interest: opening.totalInterest },
    });
  }
  // the standard full-year chart for the typed monthly amount
  const names = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
  const chart = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].map((m, i) => {
    const rem = remainingMonthsInFinancialYear(m);
    return { month: names[i], rem, interest: round2(monthly * (rate / 100) * (rem / 12)) };
  });
  res.tables.push({
    title: `Full-year chart for ${monthly} a month`, columns: [{ key: 'month', label: 'Month' }, { key: 'rem', label: 'Remaining months', kind: 'int' }, { key: 'interest', label: 'Interest', kind: 'money' }],
    rows: chart, totals: { interest: round2(chart.reduce((s, r) => s + r.interest, 0)) },
  });
  return res;
}
