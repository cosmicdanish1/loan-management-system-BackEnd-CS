import { BadRequestException } from '@nestjs/common';

/**
 * Dividend rate rules set in Modify Business Rules (ES-476): a Fixed, a Minimum and a Maximum rate, each with an
 * Active checkbox. Pure functions, no database, used both when the rules are saved and when a rate is calculated.
 */
export const DIVIDEND_RATE_KEYS = [
  'RULE_DIVIDEND_FIXED_PCT', 'RULE_DIVIDEND_FIXED_ACTIVE',
  'RULE_DIVIDEND_MIN_PCT', 'RULE_DIVIDEND_MIN_ACTIVE',
  'RULE_DIVIDEND_MAX_PCT', 'RULE_DIVIDEND_MAX_ACTIVE',
] as const;

export interface DividendRateRules {
  fixed: { active: boolean; value: number };
  min: { active: boolean; value: number };
  max: { active: boolean; value: number };
}

export const NO_DIVIDEND_RATE_RULES: DividendRateRules = {
  fixed: { active: false, value: 0 },
  min: { active: false, value: 0 },
  max: { active: false, value: 0 },
};

const asBool = (v: unknown) => v === true || v === 'true' || v === '1' || v === 'Y' || v === 1;
const asPct = (v: unknown) => Number(v) || 0;

/** Rules from a config map (system_configs values already parsed, or the raw body of a save). */
export function dividendRateRulesFrom(map: Record<string, any>): DividendRateRules {
  return {
    fixed: { active: asBool(map.RULE_DIVIDEND_FIXED_ACTIVE), value: asPct(map.RULE_DIVIDEND_FIXED_PCT) },
    min: { active: asBool(map.RULE_DIVIDEND_MIN_ACTIVE), value: asPct(map.RULE_DIVIDEND_MIN_PCT) },
    max: { active: asBool(map.RULE_DIVIDEND_MAX_ACTIVE), value: asPct(map.RULE_DIVIDEND_MAX_PCT) },
  };
}

const fmt = (n: number) => `${Number(n.toFixed(2))}%`;

/** A saved setting must make sense on its own and together with the others. Throws a 400 naming the problem. */
export function validateDividendRateRuleSettings(rules: DividendRateRules): void {
  const named: Array<[string, number]> = [['Fixed dividend rate', rules.fixed.value], ['Minimum dividend rate', rules.min.value], ['Maximum dividend rate', rules.max.value]];
  for (const [label, value] of named) {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new BadRequestException(`${label} must be between 0 and 100.`);
    if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) throw new BadRequestException(`${label} can have at most 2 decimal places.`);
  }
  if (rules.fixed.active && rules.fixed.value <= 0) throw new BadRequestException('Fixed dividend rate is switched on, so it must be more than 0.');
  if (rules.max.active && rules.max.value <= 0) throw new BadRequestException('Maximum dividend rate is switched on, so it must be more than 0.');
  if (rules.min.active && rules.max.active && rules.min.value > rules.max.value) {
    throw new BadRequestException(`Minimum dividend rate (${fmt(rules.min.value)}) cannot be more than the Maximum (${fmt(rules.max.value)}).`);
  }
  if (rules.fixed.active && rules.min.active && rules.fixed.value < rules.min.value) {
    throw new BadRequestException(`Fixed dividend rate (${fmt(rules.fixed.value)}) is below the Minimum (${fmt(rules.min.value)}).`);
  }
  if (rules.fixed.active && rules.max.active && rules.fixed.value > rules.max.value) {
    throw new BadRequestException(`Fixed dividend rate (${fmt(rules.fixed.value)}) is above the Maximum (${fmt(rules.max.value)}).`);
  }
}

/** A rate typed for a calculation must respect every active rule. */
export function assertDividendRateAllowed(rate: number, rules: DividendRateRules): void {
  if (rules.fixed.active && Math.abs(rate - rules.fixed.value) > 1e-9) {
    throw new BadRequestException(`The dividend rate is fixed at ${fmt(rules.fixed.value)} in Business Rules. ${fmt(rate)} cannot be used.`);
  }
  if (rules.min.active && rate < rules.min.value) {
    throw new BadRequestException(`The dividend rate cannot be below ${fmt(rules.min.value)} (Minimum dividend rate in Business Rules).`);
  }
  if (rules.max.active && rate > rules.max.value) {
    throw new BadRequestException(`The dividend rate cannot be above ${fmt(rules.max.value)} (Maximum dividend rate in Business Rules).`);
  }
}
