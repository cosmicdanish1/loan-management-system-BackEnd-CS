import { BadRequestException } from '@nestjs/common';
import { parseSafeDate as psd, formatDateForDB as fmt } from '../../../src/modules/shared/utils/date-utils';
import { numberToWords as ntw } from '../../../src/modules/shared/utils/number-to-words';

describe('date-utils refuses bad dates (ES-397)', () => {
  it('impossible dates are a 400 in every format, real ones (incl. 29 Feb leap) work', () => {
    for (const bad of ['31-02-2026', '31/04/2026', '29-02-2027', '2026-02-30', '2026-13-01', '00-01-2026', 'not a date', '  x ']) expect(() => psd(bad)).toThrow(BadRequestException);
    expect(fmt(psd('29-02-2028'))).toBe('2028-02-29');
    expect(fmt(psd(' 5/3/2026 '))).toBe('2026-03-05');
    expect(fmt(psd('2026-03-05'))).toBe('2026-03-05');
  });
  it('empty input still means today; an invalid Date object or number is refused', () => {
    for (const e of [undefined, null, '']) expect(fmt(psd(e))).toBe(fmt(new Date()));
    expect(() => psd(new Date('x'))).toThrow(BadRequestException);
    expect(() => psd(NaN)).toThrow(BadRequestException);
  });
});

describe('numberToWords (ES-398)', () => {
  it('zero, normal amounts and the "and" rule', () => {
    expect(ntw(0)).toBe('Zero Only');
    expect(ntw(1)).toBe('One Only');
    expect(ntw(115)).toBe('One Hundred and Fifteen Only');
    expect(ntw(100000)).toBe('One Lakh Only');
    expect(ntw(12345678)).toBe('One Crore Twenty Three Lakh Forty Five Thousand Six Hundred and Seventy Eight Only');
  });
  it('100 crore and above is spelled out, never "overflow"', () => {
    expect(ntw(1_000_000_000)).toBe('One Hundred Crore Only');
    expect(ntw(12_345_678_901)).toBe('One Thousand Two Hundred and Thirty Four Crore Fifty Six Lakh Seventy Eight Thousand Nine Hundred and One Only');
  });
  it('paise are written; rounding to paise is safe against float noise', () => {
    expect(ntw(1234.5)).toBe('One Thousand Two Hundred and Thirty Four Rupees and Fifty Paise Only');
    expect(ntw(0.05)).toBe('Zero Rupees and Five Paise Only');
    expect(ntw(10.1 + 0.2)).toBe('Ten Rupees and Thirty Paise Only');
    expect(ntw(99.999)).toBe('One Hundred Only');
  });
  it('negative gets Minus; NaN and Infinity give an empty string', () => {
    expect(ntw(-5)).toBe('Minus Five Only');
    for (const v of [NaN, Infinity, -Infinity]) expect(ntw(v)).toBe('');
  });
});

import { joinName } from '../../../src/modules/shared/utils/name-utils';
describe('joinName (ES-404)', () => {
  it('skips empty, blank and missing parts and trims each one', () => {
    expect(joinName('Asha', null, 'Rao')).toBe('Asha Rao');
    expect(joinName(' Asha ', '  ', 'Rao')).toBe('Asha Rao');
    expect(joinName('Asha', 'K', 'Rao')).toBe('Asha K Rao');
    expect(joinName(undefined, undefined, undefined)).toBe('');
    expect(joinName('Asha', '', '')).toBe('Asha');
  });
});
