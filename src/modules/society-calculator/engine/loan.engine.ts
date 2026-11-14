/**
 * Society Calculator (ES-525) - Phase 1: society-method loan EMI.
 *
 * Nothing here re-implements the maths. It calls the very functions Pass Transaction, the Sanction preview and the
 * re-agreement use (calculateConstantEmi, firstDueMonthFromDisbursement, installmentDueMonth), so a calculator figure is
 * the figure the loan will really get. The only extra arithmetic is the member-facing installment table, which follows
 * the rule of loan-repayment.service.ts getInstallmentStatus (last installment = loan amount - monthly principal x (n-1);
 * constant monthly interest).
 */
import { BadRequestException } from '@nestjs/common';
import {
  calculateConstantEmi, firstDueMonthFromDisbursement, installmentDueMonth, LoanRoundingMode, LOAN_ROUNDING_MODES,
} from '../../loan/services-v2/loan-rb-schedule.util';
import { bankStyleEmi, daysInMonth, parseYmd, round2, ymd } from './common';
import { CalculatorRules } from './rules';

export interface LoanEmiInput {
  loanAmount: number;
  annualRate: number;
  installments: number;
  /** Day the member applied: decides Slot 1 / Slot 2. */
  applicationDate: string;
  /** Day the money is paid out: decides the first due month. Defaults to the application date. */
  disbursementDate?: string;
  roundingMode?: LoanRoundingMode;
  /** Left-over closure interest of a previous agreement (re-agreement only). */
  carriedInterest?: number;
  /** Grace day of the month used as the due day. Optional (display only). */
  graceDay?: number;
}

export interface ScheduleRow {
  no: number;
  dueMonth: string; // YYYY-MM
  dueDate: string | null; // YYYY-MM-DD when a grace day is known
  openingBalance: number;
  principal: number;
  interest: number;
  installment: number;
  closingBalance: number;
}

export interface LoanEmiResult {
  inputs: {
    loanAmount: number; annualRate: number; installments: number; applicationDate: string; disbursementDate: string;
    roundingMode: LoanRoundingMode; carriedInterest: number;
  };
  slot: {
    slot: 1 | 2; subSlot: 'EARLY_MONTH' | 'LATE_MONTH' | null; label: string;
    interestDelayMonths: number; firstDueDelayMonths: number;
  };
  monthlyRate: number;
  monthlyPrincipal: number;
  totalRbInterest: number;
  delayInterest: number;
  carriedInterest: number;
  totalInterestForEmi: number;
  monthlyInterestUnrounded: number;
  monthlyInterest: number;
  emi: number;
  totalPayable: number;
  totalInterestPaid: number;
  firstDueMonth: string; // YYYY-MM
  lastDueMonth: string;
  schedule: ScheduleRow[];
  rbSchedule: Array<{ no: number; openingBalance: number; rbInterest: number; principal: number; closingBalance: number }>;
  bankStyle: { emi: number; totalPayable: number; totalInterest: number; emiDifference: number };
  /** Plain-language lines that explain each step with the numbers used. */
  steps: string[];
}

const slotLabel = (slot: 1 | 2, sub: 'EARLY_MONTH' | 'LATE_MONTH' | null): string =>
  slot === 2 ? 'Slot 2' : sub === 'LATE_MONTH' ? 'Slot 1 - late month (25th to month end)' : 'Slot 1 - early month (1st to 5th)';

/** Validate the numbers the way the real screens do: clear 400 messages, never NaN. */
export function assertLoanNumbers(loanAmount: number, annualRate: number, installments: number): void {
  if (!Number.isFinite(loanAmount) || loanAmount <= 0 || loanAmount > 999_999_999.99) {
    throw new BadRequestException('Loan amount must be a number greater than 0 (up to 999,999,999.99).');
  }
  if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 36) {
    throw new BadRequestException('Interest rate must be a number from 0 to 36 (% per year).');
  }
  if (!Number.isInteger(installments) || installments < 1 || installments > 600) {
    throw new BadRequestException('Number of installments must be a whole number from 1 to 600.');
  }
}

export function computeLoanEmi(input: LoanEmiInput, rules: CalculatorRules): LoanEmiResult {
  assertLoanNumbers(input.loanAmount, input.annualRate, input.installments);
  const appDate = parseYmd(input.applicationDate, 'Application date');
  const disbDate = parseYmd(input.disbursementDate || input.applicationDate, 'Disbursement date');
  const mode: LoanRoundingMode = (LOAN_ROUNDING_MODES as string[]).includes(String(input.roundingMode))
    ? (input.roundingMode as LoanRoundingMode)
    : rules.roundingMode;
  const carriedIn = Number(input.carriedInterest ?? 0);
  if (!Number.isFinite(carriedIn) || carriedIn < 0) throw new BadRequestException('Carried interest must be 0 or more.');

  const n = input.installments;
  const calc = calculateConstantEmi(
    input.loanAmount, input.annualRate, n, appDate,
    rules.slot.slot1DelayMonths, rules.slot.slot2DelayMonths, mode, rules.slot.startDay, rules.slot.endDay, carriedIn,
  );

  const firstDue = firstDueMonthFromDisbursement(disbDate, calc.firstDueDelayMonths);
  const grace = input.graceDay && input.graceDay > 0 ? Math.floor(input.graceDay) : 0;

  // Member-facing table: constant interest, equal principal, last installment absorbs the rounding.
  const mp = calc.monthlyPrincipal;
  const rows: ScheduleRow[] = [];
  let balance = round2(input.loanAmount);
  for (let i = 1; i <= n; i++) {
    const due = installmentDueMonth(firstDue, i);
    const principal = i === n ? round2(balance) : mp;
    const closing = i === n ? 0 : round2(balance - principal);
    const dueDate = grace > 0
      ? ymd(new Date(due.getFullYear(), due.getMonth(), Math.max(1, Math.min(grace, daysInMonth(due.getFullYear(), due.getMonth())))))
      : null;
    rows.push({
      no: i,
      dueMonth: `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}`,
      dueDate,
      openingBalance: balance,
      principal,
      interest: calc.monthlyInterestForEMI,
      installment: round2(principal + calc.monthlyInterestForEMI),
      closingBalance: closing,
    });
    balance = closing;
  }

  const totalPayable = round2(rows.reduce((s, r) => s + r.installment, 0));
  const bank = bankStyleEmi(input.loanAmount, input.annualRate, n);
  const bankEmi = round2(bank);

  const unrounded = (calc.totalInterestForEMI) / n;
  const steps = [
    `Application ${ymd(appDate)} falls in ${slotLabel(calc.slot, calc.subSlot)}: ${calc.interestDelayMonths} month(s) of delay interest, first installment ${calc.firstDueDelayMonths} month(s) after the disbursement month.`,
    `Monthly rate = ${input.annualRate} / 1200 = ${calc.monthlyRate}.  Monthly principal = ${input.loanAmount} / ${n} = ${mp}.`,
    `True reducing-balance interest over ${n} months = ${calc.totalRBInterest}.`,
    `Delay interest = ${input.loanAmount} x ${calc.monthlyRate} x ${calc.interestDelayMonths} = ${calc.delayInterest}.` + (calc.carriedInterest > 0 ? `  Carried interest = ${calc.carriedInterest}.` : ''),
    `Total interest for the EMI = ${calc.totalInterestForEMI}; divided by ${n} = ${round2(unrounded)}; rounded (${mode}) once = ${calc.monthlyInterestForEMI}.`,
    `EMI = ${mp} + ${calc.monthlyInterestForEMI} = ${calc.constantEMI}.`,
  ];

  return {
    inputs: {
      loanAmount: input.loanAmount, annualRate: input.annualRate, installments: n,
      applicationDate: ymd(appDate), disbursementDate: ymd(disbDate), roundingMode: mode, carriedInterest: calc.carriedInterest,
    },
    slot: {
      slot: calc.slot, subSlot: calc.subSlot, label: slotLabel(calc.slot, calc.subSlot),
      interestDelayMonths: calc.interestDelayMonths, firstDueDelayMonths: calc.firstDueDelayMonths,
    },
    monthlyRate: calc.monthlyRate,
    monthlyPrincipal: mp,
    totalRbInterest: calc.totalRBInterest,
    delayInterest: calc.delayInterest,
    carriedInterest: calc.carriedInterest,
    totalInterestForEmi: calc.totalInterestForEMI,
    monthlyInterestUnrounded: round2(unrounded),
    monthlyInterest: calc.monthlyInterestForEMI,
    emi: calc.constantEMI,
    totalPayable,
    totalInterestPaid: round2(totalPayable - input.loanAmount),
    firstDueMonth: rows[0].dueMonth,
    lastDueMonth: rows[rows.length - 1].dueMonth,
    schedule: rows,
    rbSchedule: calc.rbSchedule.map((r) => ({
      no: r.installmentNo, openingBalance: r.openingBalance, rbInterest: r.rbInterest, principal: r.principal, closingBalance: r.closingBalance,
    })),
    bankStyle: {
      emi: bankEmi,
      totalPayable: round2(bank * n),
      totalInterest: round2(bank * n - input.loanAmount),
      emiDifference: round2(calc.constantEMI - bankEmi),
    },
    steps,
  };
}
