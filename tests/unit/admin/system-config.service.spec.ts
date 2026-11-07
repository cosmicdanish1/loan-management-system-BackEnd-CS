import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SystemConfigService } from '../../../src/modules/admin/services/system-config.service';
import { SystemConfig, ConfigDataType, ConfigCategory } from '../../../src/modules/admin/entities/system-config.entity';
import { InterestRate } from '../../../src/modules/admin/entities/interest-rate.entity';
import { DepositSlab } from '../../../src/modules/admin/entities/deposit-slab.entity';

const cfg = (o: any = {}) => Object.assign(new SystemConfig(), { id: 1, key: 'K', value: '5', dataType: ConfigDataType.NUMBER, isReadonly: false, isActive: true, ...o });
const repo = (o: any = {}) => ({
  find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null), create: jest.fn((x) => Object.assign(new SystemConfig(), x)),
  save: jest.fn(async (x) => x), remove: jest.fn(), ...o,
}) as any;
const mk = (c: any = repo(), r: any = repo(), s: any = repo()) => new SystemConfigService(c, r, s);

describe('admin/SystemConfig entity typed values', () => {
  it('NUMBER and PERCENTAGE parse as float', () => {
    expect(cfg({ value: '12.5' }).getTypedValue()).toBe(12.5);
    expect(cfg({ value: '7', dataType: ConfigDataType.PERCENTAGE }).getTypedValue()).toBe(7);
  });
  it('BOOLEAN is true only for the text true', () => {
    expect(cfg({ dataType: ConfigDataType.BOOLEAN, value: 'true' }).getTypedValue()).toBe(true);
    expect(cfg({ dataType: ConfigDataType.BOOLEAN, value: 'TRUE' }).getTypedValue()).toBe(false);
  });
  it('JSON parses, and a broken JSON gives null', () => {
    expect(cfg({ dataType: ConfigDataType.JSON, value: '{"a":1}' }).getTypedValue()).toEqual({ a: 1 });
    expect(cfg({ dataType: ConfigDataType.JSON, value: '{bad' }).getTypedValue()).toBeNull();
  });
  it('setTypedValue stores booleans and JSON as text', () => {
    const b = cfg({ dataType: ConfigDataType.BOOLEAN }); b.setTypedValue(1); expect(b.value).toBe('true');
    const j = cfg({ dataType: ConfigDataType.JSON }); j.setTypedValue({ a: 1 }); expect(j.value).toBe('{"a":1}');
  });
});

describe('admin/SystemConfigService config CRUD', () => {
  const dto = (o: any = {}) => ({ key: 'K', name: 'n', value: '5', dataType: ConfigDataType.NUMBER, category: ConfigCategory.BUSINESS_RULES, ...o }) as any;
  it('create 409 for an existing key', async () => {
    await expect(mk(repo({ findOne: jest.fn().mockResolvedValue(cfg()) })).createSystemConfig(dto())).rejects.toThrow(ConflictException);
  });
  it('create rejects invalid number, boolean and JSON values', async () => {
    await expect(mk().createSystemConfig(dto({ value: 'abc' }))).rejects.toThrow('Invalid number value');
    await expect(mk().createSystemConfig(dto({ dataType: ConfigDataType.BOOLEAN, value: 'yes' }))).rejects.toThrow('Invalid boolean value');
    await expect(mk().createSystemConfig(dto({ dataType: ConfigDataType.JSON, value: '{' }))).rejects.toThrow('Invalid JSON value');
  });
  it('validation rules min / max are enforced', async () => {
    await expect(mk().createSystemConfig(dto({ value: '2', validationRules: '{"min":5}' }))).rejects.toThrow('at least 5');
    await expect(mk().createSystemConfig(dto({ value: '9', validationRules: '{"max":5}' }))).rejects.toThrow('at most 5');
    await expect(mk().createSystemConfig(dto({ value: '5', validationRules: '{"min":5,"max":5}' }))).resolves.toBeDefined();
  });
  it('update 404 / read-only 400 / delete read-only 400', async () => {
    await expect(mk().updateSystemConfig(1, { value: '1' } as any)).rejects.toThrow(NotFoundException);
    const ro = mk(repo({ findOne: jest.fn().mockResolvedValue(cfg({ isReadonly: true })) }));
    await expect(ro.updateSystemConfig(1, { value: '1' } as any)).rejects.toThrow(/read-only/);
    await expect(ro.deleteSystemConfig(1)).rejects.toThrow(/read-only/);
  });
  it('update validates the new value against the stored data type and rules', async () => {
    const s = mk(repo({ findOne: jest.fn().mockResolvedValue(cfg({ validationRules: '{"max":10}' })) }));
    await expect(s.updateSystemConfig(1, { value: '99' } as any)).rejects.toThrow('at most 10');
    await expect(s.updateSystemConfig(1, { value: 'abc' } as any)).rejects.toThrow('Invalid number value');
  });
  it('getConfigValue returns the typed value for an active key', async () => {
    expect(await mk(repo({ findOne: jest.fn().mockResolvedValue(cfg({ value: '18' })) })).getConfigValue('K')).toBe(18);
  });
  it('getConfigValue 404 for a missing key', async () => {
    await expect(mk().getConfigValue('NOPE')).rejects.toThrow(NotFoundException);
  });
  it('setConfigValue refuses read-only and unknown keys', async () => {
    await expect(mk().setConfigValue('X', 1)).rejects.toThrow(NotFoundException);
    await expect(mk(repo({ findOne: jest.fn().mockResolvedValue(cfg({ isReadonly: true })) })).setConfigValue('K', 1)).rejects.toThrow(BadRequestException);
  });
  it('setConfigValue rejects text for a number setting', async () => {
    await expect(mk(repo({ findOne: jest.fn().mockResolvedValue(cfg()) })).setConfigValue('K', 'abc')).rejects.toThrow(BadRequestException);
  });
  it('setConfigValue honours the validation rules (max) of the setting', async () => {
    await expect(mk(repo({ findOne: jest.fn().mockResolvedValue(cfg({ validationRules: '{"max":10}' })) })).setConfigValue('K', 99)).rejects.toThrow(BadRequestException);
  });
  it('findAll builds the filter only from the given arguments', async () => {
    const c = repo(); await mk(c).findAllSystemConfigs(ConfigCategory.BUSINESS_RULES, false);
    expect(c.find.mock.calls[0][0].where).toEqual({ category: ConfigCategory.BUSINESS_RULES, isActive: false });
    await mk(c).findAllSystemConfigs();
    expect(c.find.mock.calls[1][0].where).toBeUndefined();
  });
});

describe('admin/SystemConfigService business rules', () => {
  it('getBusinessRules returns RULE_ and SYS_ keys typed', async () => {
    const c = repo({ find: jest.fn().mockResolvedValue([cfg({ key: 'RULE_A', value: '3' }), cfg({ key: 'SYS_B', dataType: ConfigDataType.BOOLEAN, value: 'true' })]) });
    expect(await mk(c).getBusinessRules()).toEqual({ RULE_A: 3, SYS_B: true });
  });
  it('bulk update changes an existing editable rule', async () => {
    const existing = cfg({ key: 'RULE_A', value: '3' });
    const c = repo({ findOne: jest.fn().mockResolvedValue(existing) });
    await mk(c).bulkUpdateBusinessRules({ RULE_A: 9 });
    expect(existing.value).toBe('9'); expect(c.save).toHaveBeenCalled();
  });
  it('bulk update skips read-only rules silently', async () => {
    const existing = cfg({ key: 'RULE_A', value: '3', isReadonly: true });
    const c = repo({ findOne: jest.fn().mockResolvedValue(existing) });
    await mk(c).bulkUpdateBusinessRules({ RULE_A: 9 });
    expect(existing.value).toBe('3'); expect(c.save).not.toHaveBeenCalled();
  });
  it('bulk update rejects a non numeric value for a number rule', async () => {
    const c = repo({ findOne: jest.fn().mockResolvedValue(cfg({ key: 'RULE_LOAN_RATE', value: '12' })) });
    await expect(mk(c).bulkUpdateBusinessRules({ RULE_LOAN_RATE: 'abc' })).rejects.toThrow(BadRequestException);
  });
  it('bulk update rejects a negative rate when the rule has min 0', async () => {
    const c = repo({ findOne: jest.fn().mockResolvedValue(cfg({ key: 'RULE_LOAN_RATE', value: '12', validationRules: '{"min":0}' })) });
    await expect(mk(c).bulkUpdateBusinessRules({ RULE_LOAN_RATE: -5 })).rejects.toThrow(BadRequestException);
  });
  it('bulk update does not create settings with unknown keys from a request', async () => {
    const c = repo();
    await expect(mk(c).bulkUpdateBusinessRules({ GARBAGE_KEY: 'x' })).rejects.toThrow(BadRequestException);
    expect(c.save).not.toHaveBeenCalled();
  });
  it('an empty body changes nothing', async () => {
    const c = repo(); await mk(c).bulkUpdateBusinessRules({}); expect(c.save).not.toHaveBeenCalled();
  });
});

describe('admin/SystemConfigService validation (ES-293, ES-356)', () => {
  const one = (o: any = {}) => repo({ findOne: jest.fn().mockResolvedValue(cfg(o)) });
  it('setConfigValue accepts a good number and saves it', async () => {
    const c = one(); await mk(c).setConfigValue('K', 7); expect(c.save).toHaveBeenCalled();
  });
  it('a number setting rejects "12abc", an empty value and an object', async () => {
    for (const bad of ['12abc', '', '  ', {}]) await expect(mk(one()).setConfigValue('K', bad as any)).rejects.toThrow(BadRequestException);
  });
  it('min and max are both honoured, and the edges are allowed', async () => {
    const rules = '{"min":0,"max":50}';
    await expect(mk(one({ validationRules: rules })).setConfigValue('K', -1)).rejects.toThrow('at least 0');
    await expect(mk(one({ validationRules: rules })).setConfigValue('K', 51)).rejects.toThrow('at most 50');
    await expect(mk(one({ validationRules: rules })).setConfigValue('K', 0)).resolves.toBeDefined();
    await expect(mk(one({ validationRules: rules })).setConfigValue('K', 50)).resolves.toBeDefined();
  });
  it('a rejected value is not saved', async () => {
    const c = one(); await mk(c).setConfigValue('K', 'abc').catch(() => undefined); expect(c.save).not.toHaveBeenCalled();
  });
  it('a boolean setting only takes true / false', async () => {
    await expect(mk(one({ dataType: ConfigDataType.BOOLEAN, value: 'true' })).setConfigValue('K', 'maybe')).rejects.toThrow(BadRequestException);
    await expect(mk(one({ dataType: ConfigDataType.BOOLEAN, value: 'true' })).setConfigValue('K', false)).resolves.toBeDefined();
  });
  it('bulk update: one bad value rejects the whole request and nothing is saved (no half-applied rules)', async () => {
    const find = jest.fn(async ({ where }: any) => (where.key === 'RULE_A' ? cfg({ key: 'RULE_A', value: '1' }) : cfg({ key: 'RULE_B', value: '2', validationRules: '{"min":0}' })));
    const c = repo({ findOne: find });
    await expect(mk(c).bulkUpdateBusinessRules({ RULE_A: 10, RULE_B: -3 })).rejects.toThrow(/RULE_B/);
    expect(c.save).not.toHaveBeenCalled();
  });
  it('bulk update: a good request saves every rule', async () => {
    const c = repo({ findOne: jest.fn(async ({ where }: any) => cfg({ key: where.key, value: '1' })) });
    await mk(c).bulkUpdateBusinessRules({ RULE_A: 10, RULE_B: 20 }); expect(c.save).toHaveBeenCalledTimes(2);
  });
  it('bulk update may still add a new RULE_ / SYS_ rule, with its type worked out from the value', async () => {
    const c = repo(); await mk(c).bulkUpdateBusinessRules({ RULE_NEW_LIMIT: 5, SYS_NEW_FLAG: true });
    expect(c.create.mock.calls.map((x: any) => [x[0].key, x[0].dataType])).toEqual([['RULE_NEW_LIMIT', ConfigDataType.NUMBER], ['SYS_NEW_FLAG', ConfigDataType.BOOLEAN]]);
  });
  it('bulk update rejects keys that are not rule keys (lower case, other prefix, odd characters)', async () => {
    for (const k of ['rule_x', 'OTHER_X', 'RULE_X; DROP', '0', 'RULE_']) await expect(mk(repo()).bulkUpdateBusinessRules({ [k]: 1 })).rejects.toThrow(BadRequestException);
  });
  it('bulk update rejects an array or a non-object body', async () => {
    for (const bad of [[1, 2, 3], 'x', null, 5]) await expect(mk(repo()).bulkUpdateBusinessRules(bad as any)).rejects.toThrow(BadRequestException);
  });
  it('bulk update leaves a read-only rule untouched without an error', async () => {
    const c = repo({ findOne: jest.fn().mockResolvedValue(cfg({ key: 'RULE_RO', isReadonly: true })) });
    await mk(c).bulkUpdateBusinessRules({ RULE_RO: 99 }); expect(c.save).not.toHaveBeenCalled();
  });
  it('create / update also refuse "12abc" as a number now', async () => {
    await expect(mk().createSystemConfig({ key: 'K', name: 'n', value: '12abc', dataType: ConfigDataType.NUMBER, category: ConfigCategory.BUSINESS_RULES } as any)).rejects.toThrow('Invalid number value');
  });
});

describe('admin/InterestRate + DepositSlab applicability', () => {
  const rate = (o: any = {}) => Object.assign(new InterestRate(), { isActive: true, effectiveFrom: new Date('2026-01-01'), effectiveTo: null, minAmount: 0, maxAmount: 0, minTenure: 0, maxTenure: 0, ...o });
  it('applies inside the date range and amount range', () => {
    expect(rate({ minAmount: 1000, maxAmount: 5000 }).isApplicable(2000, undefined, new Date('2026-06-01'))).toBe(true);
    expect(rate({ minAmount: 1000, maxAmount: 5000 }).isApplicable(999, undefined, new Date('2026-06-01'))).toBe(false);
    expect(rate({ minAmount: 1000, maxAmount: 5000 }).isApplicable(5001, undefined, new Date('2026-06-01'))).toBe(false);
  });
  it('inactive or not yet effective rates do not apply', () => {
    expect(rate({ isActive: false }).isApplicable(1, 1, new Date('2026-06-01'))).toBe(false);
    expect(rate().isApplicable(1, 1, new Date('2025-12-31'))).toBe(false);
  });
  it('tenure range is honoured only when a tenure is given', () => {
    const r = rate({ minTenure: 12, maxTenure: 24 });
    expect(r.isApplicable(1, 6, new Date('2026-06-01'))).toBe(false);
    expect(r.isApplicable(1, 18, new Date('2026-06-01'))).toBe(true);
    expect(r.isApplicable(1, undefined, new Date('2026-06-01'))).toBe(true);
  });
  it('a rate whose end date is 31 March still applies during 31 March', () => {
    const r = rate({ effectiveTo: new Date('2026-03-31') });
    expect(r.isApplicable(1, 1, new Date('2026-03-31T10:00:00'))).toBe(true);
  });
  it('a deposit slab whose end date is today still applies today', () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const s = Object.assign(new DepositSlab(), { isActive: true, effectiveFrom: new Date('2020-01-01'), effectiveTo: today, minAmount: 0, maxAmount: 100, minTenure: 0, maxTenure: 100 });
    expect(s.isApplicable(10, 10, new Date())).toBe(true);
  });
  it('slab maturity amount is simple interest on a 365 day year', () => {
    const s = Object.assign(new DepositSlab(), { interestRate: 10 });
    expect(s.calculateMaturityAmount(1000, 365)).toBe(1100);
    expect(s.calculateMaturityAmount(1000, 730)).toBe(1200);
  });
  it('premature penalty applies only before the minimum tenure', () => {
    const s = Object.assign(new DepositSlab(), { penaltyRate: 1, minTenure: 180 });
    expect(s.calculatePenaltyAmount(10000, 100)).toBe(100);
    expect(s.calculatePenaltyAmount(10000, 180)).toBe(0);
    expect(Object.assign(new DepositSlab(), { penaltyRate: 0, minTenure: 180 }).calculatePenaltyAmount(10000, 1)).toBe(0);
  });
  it('getApplicableInterestRate returns the newest applicable one, or null', async () => {
    const a = rate({ minAmount: 0, maxAmount: 10 }); const b = rate({ minAmount: 0, maxAmount: 1000 });
    const r = repo({ find: jest.fn().mockResolvedValue([a, b]) });
    expect(await mk(repo(), r).getApplicableInterestRate('X' as any, 500, undefined, new Date('2026-06-01'))).toBe(b);
    expect(await mk(repo(), r).getApplicableInterestRate('X' as any, 5000, undefined, new Date('2026-06-01'))).toBeNull();
  });
});

describe('admin/SystemConfigService.replaceDepositSlabs', () => {
  const row = (o: any = {}) => ({ name: 'S', type: 'fixed_deposit', minAmount: 0, maxAmount: 1000, minTenure: 1, maxTenure: 12, interestRate: 7, effectiveFrom: '2026-01-01', ...o });
  const slabRepo = () => { const em: any = { delete: jest.fn(), create: jest.fn((_e, x) => x), save: jest.fn() }; return { r: repo({ manager: { transaction: jest.fn(async (fn: any) => fn(em)) } }), em }; };
  it('rejects an unknown type and non-array rows', async () => {
    await expect(mk().replaceDepositSlabs('XX', [])).rejects.toThrow(/type must be one of/);
    await expect(mk().replaceDepositSlabs('fixed_deposit', 'x')).rejects.toThrow('rows must be an array');
  });
  it('rejects a row of another type, and max below min', async () => {
    const { r } = slabRepo();
    await expect(mk(repo(), repo(), r).replaceDepositSlabs('fixed_deposit', [row({ type: 'recurring_deposit' })])).rejects.toThrow(/does not match/);
    await expect(mk(repo(), repo(), r).replaceDepositSlabs('fixed_deposit', [row({ minAmount: 500, maxAmount: 100 })])).rejects.toThrow(/maximum amount is below/);
    await expect(mk(repo(), repo(), r).replaceDepositSlabs('fixed_deposit', [row({ minTenure: 12, maxTenure: 1 })])).rejects.toThrow(/maximum tenure is below/);
  });
  it('rejects overlapping slabs inside one request', async () => {
    const { r } = slabRepo();
    await expect(mk(repo(), repo(), r).replaceDepositSlabs('fixed_deposit', [row({ minAmount: 0, maxAmount: 1000 }), row({ minAmount: 500, maxAmount: 2000 })])).rejects.toThrow(BadRequestException);
  });
  it('replaces all slabs of the type in one transaction', async () => {
    const { r, em } = slabRepo();
    expect(await mk(repo(), repo(), r).replaceDepositSlabs('fixed_deposit', [row(), row({ minAmount: 1001, maxAmount: 2000 })])).toEqual({ saved: 2 });
    expect(em.delete).toHaveBeenCalledTimes(1); expect(em.save).toHaveBeenCalledTimes(2);
  });
  it('an invalid row stops the replacement before anything is deleted', async () => {
    const { r, em } = slabRepo();
    await expect(mk(repo(), repo(), r).replaceDepositSlabs('fixed_deposit', [row(), row({ interestRate: 'abc' })])).rejects.toThrow(/Row 2/);
    expect(em.delete).not.toHaveBeenCalled();
  });
});

describe('admin/effective dates and overlapping slabs (ES-399)', () => {
  const rate = (o: any = {}) => Object.assign(new InterestRate(), { isActive: true, effectiveFrom: new Date('2026-01-01'), effectiveTo: null, minAmount: 0, maxAmount: 0, minTenure: 0, maxTenure: 0, ...o });
  const slab = (o: any = {}) => Object.assign(new DepositSlab(), { isActive: true, effectiveFrom: new Date('2020-01-01'), effectiveTo: null, minAmount: 0, maxAmount: 100, minTenure: 0, maxTenure: 100, ...o });
  const at = (s: string) => new Date(s);

  it('a rate valid until 31 March applies at any time on 31 March, even 23:59', () => {
    const r = rate({ effectiveTo: at('2026-03-31') });
    expect(r.isApplicable(1, 1, at('2026-03-31T00:00:00'))).toBe(true);
    expect(r.isApplicable(1, 1, at('2026-03-31T23:59:59'))).toBe(true);
  });
  it('...and stops on 1 April', () => {
    expect(rate({ effectiveTo: at('2026-03-31') }).isApplicable(1, 1, at('2026-04-01T00:00:01'))).toBe(false);
  });
  it('a rate with no end date never expires, and one before its start date does not apply', () => {
    expect(rate().isApplicable(1, 1, at('2099-01-01'))).toBe(true);
    expect(rate().isApplicable(1, 1, at('2025-12-31T23:59:59'))).toBe(false);
  });
  it('the end date is taken as a calendar day whether it arrives as a Date or as text', () => {
    expect(rate({ effectiveTo: '2026-03-31' as any }).isApplicable(1, 1, at('2026-03-31T18:00:00'))).toBe(true);
  });
  it('a slab ending on the last day of the year applies all day, not on the next day', () => {
    const s = slab({ effectiveTo: at('2026-12-31') });
    expect(s.isApplicable(10, 10, at('2026-12-31T15:00:00'))).toBe(true);
    expect(s.isApplicable(10, 10, at('2027-01-01T00:00:01'))).toBe(false);
  });
  it('an inactive rate or slab never applies', () => {
    expect(rate({ isActive: false }).isApplicable(1, 1, at('2026-06-01'))).toBe(false);
    expect(slab({ isActive: false }).isApplicable(10, 10, at('2026-06-01'))).toBe(false);
  });

  const row = (o: any = {}) => ({ name: 'S', type: 'fixed_deposit', minAmount: 0, maxAmount: 1000, minTenure: 1, maxTenure: 12, interestRate: 7, effectiveFrom: '2026-01-01', ...o });
  const run = async (rows: any[]) => {
    const em: any = { delete: jest.fn(), create: jest.fn((_e, x) => x), save: jest.fn() };
    const r = repo({ manager: { transaction: jest.fn(async (fn: any) => fn(em)) } });
    return { out: mk(repo(), repo(), r).replaceDepositSlabs('fixed_deposit', rows), em };
  };

  it('overlapping amounts (same tenure and period) are refused with the row numbers, and nothing is deleted', async () => {
    const { out, em } = await run([row({ minAmount: 0, maxAmount: 1000 }), row({ minAmount: 500, maxAmount: 2000 })]);
    await expect(out).rejects.toThrow(/Rows 1 and 2 overlap/);
    expect(em.delete).not.toHaveBeenCalled();
  });
  it('slabs that touch at one amount overlap (both ends are inclusive)', async () => {
    await expect((await run([row({ maxAmount: 1000 }), row({ minAmount: 1000, maxAmount: 2000 })])).out).rejects.toThrow(BadRequestException);
  });
  it('slabs one rupee apart do not overlap', async () => {
    await expect((await run([row({ maxAmount: 1000 }), row({ minAmount: 1001, maxAmount: 2000 })])).out).resolves.toEqual({ saved: 2 });
  });
  it('the same amounts for different tenures do not overlap', async () => {
    await expect((await run([row({ minTenure: 1, maxTenure: 12 }), row({ minTenure: 13, maxTenure: 24 })])).out).resolves.toEqual({ saved: 2 });
  });
  it('the same amounts and tenures for different periods do not overlap (an old rate and its replacement)', async () => {
    await expect((await run([row({ effectiveTo: '2026-03-31' }), row({ effectiveFrom: '2026-04-01' })])).out).resolves.toEqual({ saved: 2 });
  });
  it('...but periods that share a day do overlap', async () => {
    await expect((await run([row({ effectiveTo: '2026-04-01' }), row({ effectiveFrom: '2026-04-01' })])).out).rejects.toThrow(BadRequestException);
  });
  it('an open-ended slab overlaps any later one with the same ranges', async () => {
    await expect((await run([row(), row({ effectiveFrom: '2030-01-01' })])).out).rejects.toThrow(BadRequestException);
  });
  it('the overlap is found between any two rows, not only neighbours', async () => {
    await expect((await run([row({ maxAmount: 100 }), row({ minAmount: 5000, maxAmount: 6000 }), row({ minAmount: 50, maxAmount: 80 })])).out).rejects.toThrow(/Rows 1 and 3/);
  });
  it('an empty list still clears the type, and one row never overlaps itself', async () => {
    await expect((await run([])).out).resolves.toEqual({ saved: 0 });
    await expect((await run([row()])).out).resolves.toEqual({ saved: 1 });
  });
});
