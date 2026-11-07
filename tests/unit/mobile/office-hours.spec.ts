import { officeStateAt, parseOfficeDays } from '../../../src/modules/mobile/status/office-hours';

// All instants below are given in UTC; the office zone is Asia/Kolkata (UTC+05:30, no daylight saving).
describe('officeStateAt (Asia/Kolkata)', () => {
  const DAYS = [1, 2, 3, 4, 5, 6]; // Monday to Saturday

  it('is open between 10:00 and 18:00 office time on an office day', () => {
    // Wed 14 Oct 2026 12:00 IST = 06:30 UTC
    const s = officeStateAt(new Date('2026-10-14T06:30:00Z'), '10:00', '18:00', DAYS);
    expect(s).toMatchObject({ isOpen: true, isOfficeDay: true, isoWeekday: 3, localTime: '12:00' });
  });

  it('uses office time, not UTC: 09:59 IST is closed, 10:00 IST is open, 17:59 open, 18:00 closed', () => {
    const at = (utc: string) => officeStateAt(new Date(utc), '10:00', '18:00', DAYS).isOpen;
    expect(at('2026-10-14T04:29:00Z')).toBe(false); // 09:59 IST
    expect(at('2026-10-14T04:30:00Z')).toBe(true); // 10:00 IST
    expect(at('2026-10-14T12:29:00Z')).toBe(true); // 17:59 IST
    expect(at('2026-10-14T12:30:00Z')).toBe(false); // 18:00 IST
  });

  it('handles the date change between UTC and IST (Tue 22:00 UTC is Wed 03:30 IST)', () => {
    const s = officeStateAt(new Date('2026-10-13T22:00:00Z'), '10:00', '18:00', DAYS);
    expect(s.isoWeekday).toBe(3);
    expect(s.localTime).toBe('03:30');
    expect(s.isOpen).toBe(false);
  });

  it('is closed on a day that is not an office day', () => {
    // Sun 18 Oct 2026 12:00 IST
    const s = officeStateAt(new Date('2026-10-18T06:30:00Z'), '10:00', '18:00', DAYS);
    expect(s).toMatchObject({ isoWeekday: 7, isOfficeDay: false, isOpen: false });
  });

  it('falls back to 10:00-18:00 Monday to Saturday when settings are bad or empty', () => {
    const s = officeStateAt(new Date('2026-10-14T06:30:00Z'), 'nonsense', '25:99', []);
    expect(s.isOpen).toBe(true);
  });

  it('shows midnight as 00:xx, not 24:xx', () => {
    // 00:05 IST on Thu = 18:35 UTC on Wed
    expect(officeStateAt(new Date('2026-10-14T18:35:00Z'), '10:00', '18:00', DAYS).localTime).toBe('00:05');
  });
});

describe('parseOfficeDays', () => {
  it('parses ISO weekday numbers and ignores junk', () => {
    expect(parseOfficeDays('1, 2,3,x,9,0,7')).toEqual([1, 2, 3, 7]);
    expect(parseOfficeDays('')).toEqual([]);
  });
});
