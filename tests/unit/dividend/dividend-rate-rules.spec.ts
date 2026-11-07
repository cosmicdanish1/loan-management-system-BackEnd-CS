import { BadRequestException } from '@nestjs/common';
import {
  NO_DIVIDEND_RATE_RULES, assertDividendRateAllowed, dividendRateRulesFrom, validateDividendRateRuleSettings,
} from '../../../src/modules/dividend/dividend-rate-rules';

// ES-476: Fixed / Minimum / Maximum dividend rate, each with an Active checkbox.

const rules = (o: any = {}) => dividendRateRulesFrom(o);

describe('dividendRateRulesFrom', () => {
  it('reads values and the Active checkboxes (true, "true", "Y", 1)', () => {
    const r = rules({ RULE_DIVIDEND_FIXED_ACTIVE: 'true', RULE_DIVIDEND_FIXED_PCT: '12.5', RULE_DIVIDEND_MIN_ACTIVE: 1, RULE_DIVIDEND_MIN_PCT: 5, RULE_DIVIDEND_MAX_ACTIVE: 'Y', RULE_DIVIDEND_MAX_PCT: '20' });
    expect(r).toEqual({ fixed: { active: true, value: 12.5 }, min: { active: true, value: 5 }, max: { active: true, value: 20 } });
  });
  it('nothing saved = nothing active', () => {
    expect(rules({})).toEqual(NO_DIVIDEND_RATE_RULES);
    expect(rules({ RULE_DIVIDEND_MAX_ACTIVE: 'false', RULE_DIVIDEND_MAX_PCT: 15 }).max.active).toBe(false);
  });
});

describe('validateDividendRateRuleSettings (saving the rules)', () => {
  it('accepts a sensible combination and an all-off setting', () => {
    expect(() => validateDividendRateRuleSettings(rules())).not.toThrow();
    expect(() => validateDividendRateRuleSettings(rules({ RULE_DIVIDEND_MIN_ACTIVE: true, RULE_DIVIDEND_MIN_PCT: 5, RULE_DIVIDEND_MAX_ACTIVE: true, RULE_DIVIDEND_MAX_PCT: 15, RULE_DIVIDEND_FIXED_ACTIVE: true, RULE_DIVIDEND_FIXED_PCT: 10 }))).not.toThrow();
  });
  it.each([
    ['a value above 100', { RULE_DIVIDEND_MAX_ACTIVE: true, RULE_DIVIDEND_MAX_PCT: 150 }, 'between 0 and 100'],
    ['a negative value', { RULE_DIVIDEND_MIN_PCT: -1 }, 'between 0 and 100'],
    ['more than 2 decimals', { RULE_DIVIDEND_FIXED_PCT: 12.345 }, '2 decimal'],
    ['Fixed switched on with 0', { RULE_DIVIDEND_FIXED_ACTIVE: true, RULE_DIVIDEND_FIXED_PCT: 0 }, 'Fixed dividend rate is switched on'],
    ['Maximum switched on with 0', { RULE_DIVIDEND_MAX_ACTIVE: true, RULE_DIVIDEND_MAX_PCT: 0 }, 'Maximum dividend rate is switched on'],
    ['Minimum above Maximum', { RULE_DIVIDEND_MIN_ACTIVE: true, RULE_DIVIDEND_MIN_PCT: 20, RULE_DIVIDEND_MAX_ACTIVE: true, RULE_DIVIDEND_MAX_PCT: 10 }, 'cannot be more than the Maximum'],
    ['Fixed below Minimum', { RULE_DIVIDEND_FIXED_ACTIVE: true, RULE_DIVIDEND_FIXED_PCT: 4, RULE_DIVIDEND_MIN_ACTIVE: true, RULE_DIVIDEND_MIN_PCT: 5 }, 'below the Minimum'],
    ['Fixed above Maximum', { RULE_DIVIDEND_FIXED_ACTIVE: true, RULE_DIVIDEND_FIXED_PCT: 16, RULE_DIVIDEND_MAX_ACTIVE: true, RULE_DIVIDEND_MAX_PCT: 15 }, 'above the Maximum'],
  ])('refuses %s', (_n, body, text) => {
    expect(() => validateDividendRateRuleSettings(rules(body))).toThrow(text as string);
    expect(() => validateDividendRateRuleSettings(rules(body))).toThrow(BadRequestException);
  });
  it('an inactive rule is not checked against the others (Min 20 / Max 10 while Max is off)', () => {
    expect(() => validateDividendRateRuleSettings(rules({ RULE_DIVIDEND_MIN_ACTIVE: true, RULE_DIVIDEND_MIN_PCT: 20, RULE_DIVIDEND_MAX_ACTIVE: false, RULE_DIVIDEND_MAX_PCT: 10 }))).not.toThrow();
  });
});

describe('assertDividendRateAllowed (calculating a dividend)', () => {
  it('no active rule: any rate passes', () => {
    expect(() => assertDividendRateAllowed(37.5, NO_DIVIDEND_RATE_RULES)).not.toThrow();
  });
  it('Fixed: only that rate passes', () => {
    const r = rules({ RULE_DIVIDEND_FIXED_ACTIVE: true, RULE_DIVIDEND_FIXED_PCT: 12 });
    expect(() => assertDividendRateAllowed(12, r)).not.toThrow();
    expect(() => assertDividendRateAllowed(11, r)).toThrow('fixed at 12%');
    expect(() => assertDividendRateAllowed(12.5, r)).toThrow('cannot be used');
  });
  it('Minimum / Maximum refuse a rate outside the range, accept the edges', () => {
    const r = rules({ RULE_DIVIDEND_MIN_ACTIVE: true, RULE_DIVIDEND_MIN_PCT: 5, RULE_DIVIDEND_MAX_ACTIVE: true, RULE_DIVIDEND_MAX_PCT: 15 });
    expect(() => assertDividendRateAllowed(5, r)).not.toThrow();
    expect(() => assertDividendRateAllowed(15, r)).not.toThrow();
    expect(() => assertDividendRateAllowed(4.99, r)).toThrow('below 5%');
    expect(() => assertDividendRateAllowed(15.01, r)).toThrow('above 15%');
  });
  it('a switched-off Maximum is ignored', () => {
    expect(() => assertDividendRateAllowed(90, rules({ RULE_DIVIDEND_MAX_ACTIVE: false, RULE_DIVIDEND_MAX_PCT: 15 }))).not.toThrow();
  });
});
