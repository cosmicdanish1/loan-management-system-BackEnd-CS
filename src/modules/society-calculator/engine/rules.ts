/**
 * Society Calculator (ES-525): the live Business Rules the calculator works with.
 *
 * Everything here is READ ONLY. The values come from the same places the real screens read them
 * (busrules latest row + system_configs), with the same fallbacks, so a calculator figure and the
 * real figure for the same inputs can never disagree because of a different rate or rule.
 */
import { DEFAULT_SLOT1_END_DAY, DEFAULT_SLOT1_START_DAY, LoanRoundingMode, LOAN_ROUNDING_MODES } from '../../loan/services-v2/loan-rb-schedule.util';

export type LoanTypeCode = 'RLN' | 'ALN' | 'ELN';

export interface LoanTypeRules {
  code: LoanTypeCode;
  name: string;
  /** Interest rate, % per year (busrules.{type}rate). */
  rate: number;
  /** Tier-2 penalty, % per year (busrules.{type}penalrate). */
  penalRate: number;
  /** Grace day of the month (busrules.{type}gracedays). */
  graceDays: number;
  /** Tier-1 same-month fee: percent and divisor (busrules.{type}smpct / smdiv). */
  smPct: number;
  smDiv: number;
  maxAmount: number;
  maxInstallments: number;
}

export interface CalculatorRules {
  asOf: string;
  loanTypes: Record<LoanTypeCode, LoanTypeRules>;
  slot: { startDay: number; endDay: number; slot1DelayMonths: number; slot2DelayMonths: number };
  roundingMode: LoanRoundingMode;
  penaltyEnabled: boolean;
  eligibility: {
    maxLimit: number;
    rdPct: number;
    sharePct: number;
    shortfallMode: 'DEDUCT' | 'BLOCK' | 'IGNORE';
    limitCalc: 'OUTSTANDING_PLUS_NEW' | 'NEW_ONLY';
    shareMinBalance: number;
  };
  rd: { rate: number; minBalanceAfterWithdrawal: number };
  loanAgainstRd: { pct: number; ceiling: number };
  /** Same defaults the app uses when a card is empty (see resolveLoanRateDefaults / validateLoanEligibility). */
  oldEmiFlagTolerance: number;
}

export const LOAN_TYPE_NAMES: Record<LoanTypeCode, string> = {
  RLN: 'Regular Loan',
  ALN: 'Emergency Loan',
  ELN: 'Loan Against RD',
};

const CONFIG_KEYS = [
  'RULE_LOAN_SLOT1_START_DAY', 'RULE_LOAN_SLOT1_END_DAY', 'RULE_LOAN_SLOT1_DELAY_MONTHS', 'RULE_LOAN_SLOT2_DELAY_MONTHS',
  'RULE_LOAN_ROUNDING_MODE', 'RULE_TIERED_LOAN_PENALTY_ENABLED',
  'RULE_LOAN_R_MAX_LIMIT', 'RULE_LOAN_R_RD_PCT', 'RULE_LOAN_R_SHARE_PCT', 'RULE_LOAN_R_SHORTFALL_MODE',
  'RULE_LOAN_R_LIMIT_CALC', 'RULE_LOAN_R_SHARE_MIN_BALANCE',
  'RULE_RD_OPENING_BALANCE_RATE', 'RULE_RD_MIN_BALANCE_AFTER_WITHDRAWAL', 'RULE_LOAN_OLD_EMI_FLAG_TOLERANCE',
];

/** Minimal query surface so the loader can be unit-tested with a fake. */
export interface QueryLike {
  query(sql: string, params?: any[]): Promise<any[]>;
}

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};
const positive = (v: unknown, fallback: number): number => {
  const n = num(v, NaN);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const nonNegative = (v: unknown, fallback: number): number => {
  const n = num(v, NaN);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const truthy = (v: unknown): boolean => ['true', '1', 'y', 'yes'].includes(String(v ?? '').trim().toLowerCase());

/** Rules as they would be with an empty database: the documented fallbacks of the real screens. */
export function defaultRules(asOf: string = new Date().toISOString().slice(0, 10)): CalculatorRules {
  const mk = (code: LoanTypeCode, rate: number, maxAmount: number, maxInstallments: number): LoanTypeRules => ({
    code, name: LOAN_TYPE_NAMES[code], rate, penalRate: 2, graceDays: 0, smPct: 1, smDiv: 4, maxAmount, maxInstallments,
  });
  return {
    asOf,
    loanTypes: { RLN: mk('RLN', 12, 500000, 60), ALN: mk('ALN', 12, 500000, 60), ELN: mk('ELN', 9, 1000000, 120) },
    slot: { startDay: DEFAULT_SLOT1_START_DAY, endDay: DEFAULT_SLOT1_END_DAY, slot1DelayMonths: 1, slot2DelayMonths: 2 },
    roundingMode: 'NEAREST',
    penaltyEnabled: false,
    eligibility: { maxLimit: 1000000, rdPct: 5, sharePct: 5, shortfallMode: 'DEDUCT', limitCalc: 'OUTSTANDING_PLUS_NEW', shareMinBalance: 1000 },
    rd: { rate: 7, minBalanceAfterWithdrawal: 1000 },
    loanAgainstRd: { pct: 90, ceiling: 500000 },
    oldEmiFlagTolerance: 10,
  };
}

/** Build the rules from a busrules row and a system_configs key/value map (both optional). */
export function buildRules(busrules: Record<string, any> | undefined, configs: Record<string, string>, asOf?: string): CalculatorRules {
  const base = defaultRules(asOf);
  const row = busrules || {};

  (['RLN', 'ALN', 'ELN'] as LoanTypeCode[]).forEach((code) => {
    const p = code.toLowerCase();
    const t = base.loanTypes[code];
    t.rate = positive(row[`${p}rate`], t.rate);
    t.penalRate = positive(row[`${p}penalrate`], t.penalRate);
    t.graceDays = nonNegative(row[`${p}gracedays`], t.graceDays);
    t.smPct = nonNegative(row[`${p}smpct`], t.smPct);
    t.smDiv = positive(row[`${p}smdiv`], t.smDiv);
    t.maxAmount = positive(row[`${p}maxloanamt`], t.maxAmount);
    t.maxInstallments = positive(row[`${p}maxnoinst`], t.maxInstallments);
  });

  base.slot = {
    startDay: positive(configs.RULE_LOAN_SLOT1_START_DAY, base.slot.startDay),
    endDay: positive(configs.RULE_LOAN_SLOT1_END_DAY, base.slot.endDay),
    slot1DelayMonths: positive(configs.RULE_LOAN_SLOT1_DELAY_MONTHS, base.slot.slot1DelayMonths),
    slot2DelayMonths: positive(configs.RULE_LOAN_SLOT2_DELAY_MONTHS, base.slot.slot2DelayMonths),
  };
  const mode = String(configs.RULE_LOAN_ROUNDING_MODE ?? '').toUpperCase();
  base.roundingMode = (LOAN_ROUNDING_MODES as string[]).includes(mode) ? (mode as LoanRoundingMode) : 'NEAREST';
  base.penaltyEnabled = truthy(configs.RULE_TIERED_LOAN_PENALTY_ENABLED);

  const sm = String(configs.RULE_LOAN_R_SHORTFALL_MODE ?? 'DEDUCT').toUpperCase();
  const lc = String(configs.RULE_LOAN_R_LIMIT_CALC ?? 'OUTSTANDING_PLUS_NEW').toUpperCase();
  base.eligibility = {
    maxLimit: positive(configs.RULE_LOAN_R_MAX_LIMIT, base.eligibility.maxLimit),
    rdPct: nonNegative(configs.RULE_LOAN_R_RD_PCT, base.eligibility.rdPct),
    sharePct: nonNegative(configs.RULE_LOAN_R_SHARE_PCT, base.eligibility.sharePct),
    shortfallMode: (['DEDUCT', 'BLOCK', 'IGNORE'].includes(sm) ? sm : 'DEDUCT') as 'DEDUCT' | 'BLOCK' | 'IGNORE',
    limitCalc: (lc === 'NEW_ONLY' ? 'NEW_ONLY' : 'OUTSTANDING_PLUS_NEW') as 'OUTSTANDING_PLUS_NEW' | 'NEW_ONLY',
    shareMinBalance: nonNegative(configs.RULE_LOAN_R_SHARE_MIN_BALANCE, base.eligibility.shareMinBalance),
  };
  base.rd = {
    rate: nonNegative(configs.RULE_RD_OPENING_BALANCE_RATE, base.rd.rate),
    minBalanceAfterWithdrawal: nonNegative(configs.RULE_RD_MIN_BALANCE_AFTER_WITHDRAWAL, base.rd.minBalanceAfterWithdrawal),
  };
  // Loan Against RD: 0 / empty on the card means 90 % and 5,00,000 (same fallbacks as loan-eligibility.service.ts).
  base.loanAgainstRd = {
    pct: positive(row.loanagainstdeppercent, 90),
    ceiling: positive(row.elnmaxloanamt, 500000),
  };
  base.oldEmiFlagTolerance = nonNegative(configs.RULE_LOAN_OLD_EMI_FLAG_TOLERANCE, base.oldEmiFlagTolerance);
  return base;
}

/** Read the live rules. A missing table or key never fails the calculator: it falls back to the documented defaults. */
export async function loadCalculatorRules(db: QueryLike, asOf?: string): Promise<CalculatorRules> {
  let busrules: Record<string, any> | undefined;
  try {
    const rows = await db.query(`SELECT * FROM busrules ORDER BY appdate DESC, srno DESC NULLS LAST LIMIT 1`);
    busrules = rows[0];
  } catch {
    try {
      const rows = await db.query(`SELECT * FROM busrules ORDER BY appdate DESC LIMIT 1`);
      busrules = rows[0];
    } catch { busrules = undefined; }
  }
  const configs: Record<string, string> = {};
  try {
    const rows = await db.query(`SELECT key, value FROM system_configs WHERE key = ANY($1) AND "isActive" = true`, [CONFIG_KEYS]);
    for (const r of rows) configs[r.key] = String(r.value);
  } catch { /* defaults */ }
  return buildRules(busrules, configs, asOf);
}
