/** Society Calculator (ES-525) - penalty tab: tier 0 / 1 / 2 of one installment (SOP section 10). Uses the real computeTier. */
import { computeTier } from '../../loan/services-v2/loan-repayment.service';
import { daysInMonth, round2, ymd } from './common';
import { Body, oneOf, optInt, optNum, reqDate, reqNum } from './validate';
import { CalcResult, emptyResult } from './result';
import { CalculatorRules, LoanTypeCode } from './rules';

export function computePenalty(b: Body, rules: CalculatorRules): CalcResult {
  const type = oneOf<LoanTypeCode>(b, 'loanType', 'Loan type', ['RLN', 'ALN', 'ELN'], 'RLN');
  const tr = rules.loanTypes[type];
  const principalDue = reqNum(b, 'principalDue', 'Unpaid principal of the installment', 0.01);
  const dueMonth = reqDate(b, 'dueMonthDate', 'A date in the due month');
  const asOf = reqDate(b, 'asOfDate', 'Calculate as on');
  const grace = optInt(b, 'graceDay', 'Grace day', tr.graceDays, 0, 31);
  const rate = optNum(b, 'penalRate', 'Penalty rate (% per year)', tr.penalRate, 0, 100);
  const smPct = optNum(b, 'smPct', 'Same-month fee percent', tr.smPct, 0, 100);
  const smDiv = optNum(b, 'smDiv', 'Same-month fee divisor', tr.smDiv, 0.0001, 1000);
  const source = oneOf(b, 'source', 'Payment source', ['CASH', 'DEMAND'] as const, 'CASH');
  const dueDay = Math.max(1, Math.min(grace || 1, daysInMonth(dueMonth.getFullYear(), dueMonth.getMonth())));
  const due = new Date(dueMonth.getFullYear(), dueMonth.getMonth(), dueDay);
  const t = computeTier(principalDue, false, due, asOf, grace, rate, smPct, smDiv, source === 'CASH');

  const res = emptyResult();
  const tierLabel = ['Tier 0 - no penalty (inside grace)', 'Tier 1 - same-month fee', 'Tier 2 - monthly penalty'][t.tier] as string;
  res.kpis.push(
    { label: 'Penalty due', value: t.penalDue, kind: 'money', tone: t.penalDue > 0 ? 'danger' : 'success', sub: tierLabel },
    { label: 'Months overdue', value: t.monthsOverdue, kind: 'int', tone: 'warning' },
    { label: 'Due date (grace day)', value: ymd(due), kind: 'text', tone: 'info' },
    { label: 'Principal + penalty', value: round2(principalDue + t.penalDue), kind: 'money', tone: 'info', sub: 'unpaid principal plus penalty' },
  );
  res.steps.push(
    `Due date = day ${dueDay} of the due month (the grace day). Calculated on ${ymd(asOf)}: ${t.monthsOverdue} complete month(s) after the due month.`,
    t.tier === 2 ? `Tier 2: ${principalDue} x (${rate}/100/12) x ${t.monthsOverdue} = ${t.penalDue}.`
      : t.tier === 1 ? `Tier 1 (past the grace day in the due month, cash): (${smPct}/100 x ${principalDue}) / ${smDiv} = ${t.penalDue}.`
      : source === 'DEMAND' && asOf.getMonth() === due.getMonth() && asOf.getFullYear() === due.getFullYear() && asOf.getDate() > grace
        ? 'Demand (payroll) money never pays the same-month fee: no penalty.' : 'Inside the grace period: no penalty.',
  );
  if (!rules.penaltyEnabled) res.notes.push('The tiered penalty is switched off in Business Rules: the real screens charge no penalty until it is switched on.');
  res.notes.push('One penalty per installment, ever: once a penalty is recorded against a due month, that month is never penalised again.');

  const rows: Array<Record<string, any>> = [];
  const lastDay = daysInMonth(due.getFullYear(), due.getMonth());
  const probes: Array<[Date, string]> = [
    [new Date(due.getFullYear(), due.getMonth(), Math.max(1, Math.min(grace || 1, lastDay))), 'Grace day of the due month'],
    [new Date(due.getFullYear(), due.getMonth(), Math.min(lastDay, (grace || 1) + 1)), 'Day after the grace day (cash)'],
  ];
  for (let m = 1; m <= 6; m++) probes.push([new Date(due.getFullYear(), due.getMonth() + m, 1), `1st of month +${m}`]);
  for (const [d, label] of probes) {
    const x = computeTier(principalDue, false, due, d, grace, rate, smPct, smDiv, true);
    rows.push({ when: `${label} (${ymd(d)})`, tier: `Tier ${x.tier}`, months: x.monthsOverdue, penalty: x.penalDue });
  }
  res.tables.push({
    title: 'How the penalty grows (cash)',
    columns: [{ key: 'when', label: 'Date' }, { key: 'tier', label: 'Tier' }, { key: 'months', label: 'Months late', kind: 'int' }, { key: 'penalty', label: 'Penalty', kind: 'money' }],
    rows,
  });
  return res;
}
