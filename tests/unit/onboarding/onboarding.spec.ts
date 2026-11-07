import { BadRequestException } from '@nestjs/common';
import { OnboardingService } from '../../../src/modules/onboarding/onboarding.service';
import { TermsService } from '../../../src/modules/onboarding/terms.service';
import { ChecklistService } from '../../../src/modules/onboarding/checklist.service';
import { InsightsService } from '../../../src/modules/onboarding/insights.service';

function ds(routes: Array<[RegExp, any]> = []) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    for (const [re, rows] of routes) if (re.test(sql)) return typeof rows === 'function' ? rows(sql, params) : rows;
    return [];
  });
  return { query, calls } as any;
}

describe('OnboardingService', () => {
  describe('status', () => {
    const status = async (row: any, globalMode?: string) => {
      const d = ds([[/FROM system_settings/, globalMode ? [{ value: globalMode }] : []], [/FROM user_onboarding/, row ? [row] : []]]);
      return new OnboardingService(d).getStatus(1);
    };
    it('a new user with the default "first" mode is shown the tour', async () => {
      expect(await status(null)).toMatchObject({ shouldShow: true, effectiveMode: 'first', userMode: 'default', globalMode: 'first' });
    });
    it('"first" is used up once completed', async () => {
      expect((await status({ mode_override: 'default', completed_at: '2026-01-01T00:00:00Z' })).shouldShow).toBe(false);
    });
    it('"always" shows on every login even after completing', async () => {
      expect((await status({ mode_override: 'default', completed_at: '2026-01-01T00:00:00Z' }, 'always')).shouldShow).toBe(true);
    });
    it('"never" never auto-shows', async () => {
      expect((await status({ mode_override: 'never', completed_at: null })).shouldShow).toBe(false);
    });
    it('a user override beats the global mode', async () => {
      expect(await status({ mode_override: 'always', completed_at: '2026-01-01T00:00:00Z' }, 'never')).toMatchObject({ effectiveMode: 'always', shouldShow: true });
    });
    it('a junk global value falls back to "first"', async () => {
      expect((await status(null, 'sometimes')).globalMode).toBe('first');
    });
  });

  describe('modes', () => {
    it('setGlobalMode rejects an unknown mode before writing', async () => {
      const d = ds();
      await expect(new OnboardingService(d).setGlobalMode('weekly')).rejects.toBeInstanceOf(BadRequestException);
      expect(d.query).not.toHaveBeenCalled();
    });
    it('setUserMode accepts default/first/always/never and rejects the rest', async () => {
      const s = new OnboardingService(ds());
      for (const m of ['default', 'first', 'always', 'never']) await expect(s.setUserMode(1, m)).resolves.toBeDefined();
      await expect(s.setUserMode(1, 'x')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('complete / steps', () => {
    it('complete records the version only the first time (COALESCE keeps the older one)', async () => {
      const d = ds();
      await new OnboardingService(d).complete(7, '1.9.0');
      expect(d.calls[0].sql).toMatch(/COALESCE\(user_onboarding\.last_seen_version, \$2\)/);
      expect(d.calls[0].params).toEqual([7, '1.9.0']);
    });
    it('saveStep cuts the step name to 40 characters', async () => {
      const d = ds();
      await new OnboardingService(d).saveStep(1, 'x'.repeat(100));
      expect(d.calls[0].params[1]).toHaveLength(40);
    });
  });

  describe('What\'s New seen', () => {
    it('accepts a normal version like 1.8.0', async () => {
      const d = ds();
      await expect(new OnboardingService(d).markWhatsNewSeen(1, '1.8.0')).resolves.toBeDefined();
      expect(d.calls[0].params).toEqual([1, '1.8.0']);
    });
    it('accepts a multi-digit version like 12.40.105', async () => {
      await expect(new OnboardingService(ds()).markWhatsNewSeen(1, '12.40.105')).resolves.toBeDefined();
    });
    it('rejects text that is not a version', async () => {
      for (const v of ['abc', '1.8', '1.8.0; DROP', '', 'ddd']) await expect(new OnboardingService(ds()).markWhatsNewSeen(1, v)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('profile', () => {
    it('unknown user gives null', async () => {
      expect(await new OnboardingService(ds()).getProfile(1)).toBeNull();
    });
    it('falls back to the username when there is no name and trims the role', async () => {
      const d = ds([[/FROM usermaster u/, [{ susername: 'clerk1', first_name: null, last_name: null, userlevel: 'CLERK   ', email: '', avatar: null, date_of_creation: null }]]]);
      expect(await new OnboardingService(d).getProfile(1)).toMatchObject({ fullName: 'clerk1', role: 'CLERK', email: null, memberSince: null, lastLogin: null });
    });
  });
});

describe('TermsService', () => {
  const settings = (version?: string) => ds([[/FROM system_settings/, (_s: string, p: any[]) => (p[0] === 'terms.version' && version ? [{ value: version }] : [])]]);

  it('uses the built-in draft when nothing has been published', async () => {
    const t = await new TermsService(settings()).getTerms();
    expect(t.version).toBe('1.0-draft');
    expect(t.text).toContain('TERMS AND CONDITIONS');
  });
  it('status: not accepted until a row exists for this version', async () => {
    const d = ds([[/FROM terms_acceptances/, []]]);
    expect(await new TermsService(d).status(1)).toMatchObject({ accepted: false, acceptedAt: null });
  });
  it('accept with an old version is refused', async () => {
    await expect(new TermsService(settings('2.0')).accept(1, 'u', '1.0-draft')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('accept is idempotent (ON CONFLICT DO NOTHING) and cuts the username to 100 characters', async () => {
    const d = ds([[/FROM system_settings/, []]]);
    await new TermsService(d).accept(1, 'u'.repeat(300), '1.0-draft');
    const ins = d.calls.find((c: any) => /INSERT INTO terms_acceptances/.test(c.sql));
    expect(ins.sql).toMatch(/ON CONFLICT \(user_id, version\) DO NOTHING/);
    expect(ins.params[1]).toHaveLength(100);
  });
  it('publish needs a version and text', async () => {
    const t = new TermsService(settings());
    await expect(t.publish('  ', 'text')).rejects.toBeInstanceOf(BadRequestException);
    await expect(t.publish('2.0', '   ')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('publish refuses to reuse the current version (users would not be asked again)', async () => {
    await expect(new TermsService(settings('2.0')).publish('2.0', 'new text')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('publish writes the version and the text', async () => {
    const d = settings('1.0');
    expect(await new TermsService(d).publish(' 2.0 ', 'text')).toEqual({ version: '2.0' });
    expect(d.calls.filter((c: any) => /INSERT INTO system_settings/.test(c.sql))).toHaveLength(2);
  });
  it('publish with whitespace around the same version is still seen as the same version', async () => {
    await expect(new TermsService(settings('2.0')).publish('2.0  ', 'x')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ChecklistService', () => {
  const build = (progress: string[] = [], accepted = false, totp = false) => {
    const d = ds([
      [/FROM onboarding_progress WHERE user_id = \$1$/, progress.map((item) => ({ item }))],
      [/count\(\*\)::int AS c FROM onboarding_progress/, [{ c: progress.filter((p) => p.startsWith('window:')).length }]],
      [/FROM usermaster WHERE userid/, [{ totp_enabled: totp }]],
    ]);
    const terms: any = { status: jest.fn(async () => ({ accepted })) };
    return { svc: new ChecklistService(d, terms), d };
  };

  it('a new user has 0 of 7 done', async () => {
    expect(await build().svc.status(1)).toMatchObject({ doneCount: 0, total: 7, dismissed: false, windowsOpened: 0, windowsNeeded: 3 });
  });
  it('terms and 2FA come from their own tables, the rest from ticks', async () => {
    const s = await build(['profile', 'tour'], true, true).svc.status(1);
    expect(s.items.filter((i) => i.done).map((i) => i.id).sort()).toEqual(['profile', 'terms', 'tour', 'twofa']);
  });
  it('"windows" is done after three different windows were opened', async () => {
    const s = await build(['window:A1', 'window:B2', 'window:C3']).svc.status(1);
    expect(s.items.find((i) => i.id === 'windows')!.done).toBe(true);
  });
  it('mark rejects an item the app may not tick (terms, twofa, anything unknown)', async () => {
    const { svc } = build();
    for (const bad of ['terms', 'twofa', 'hack', 'window:lower', 'window:', 'window:A;DROP']) await expect(svc.mark(1, bad)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('mark accepts the tickable items and window ids', async () => {
    const { svc, d } = build();
    for (const ok of ['profile', 'password', 'tour', 'slides', 'dismissed', 'window:MEMBER_MASTER']) await expect(svc.mark(1, ok)).resolves.toBeDefined();
    expect(d.calls.some((c: any) => /ON CONFLICT \(user_id, item\) DO NOTHING/.test(c.sql))).toBe(true);
  });
  it('the number of remembered windows per user is capped at 50', async () => {
    const d = ds([[/count\(\*\)::int AS c FROM onboarding_progress/, [{ c: 50 }]], [/FROM onboarding_progress WHERE user_id = \$1$/, []], [/FROM usermaster/, [{}]]]);
    const svc = new ChecklistService(d, { status: async () => ({ accepted: false }) } as any);
    await svc.mark(1, 'window:NEW_ONE');
    expect(d.calls.some((c: any) => /INSERT INTO onboarding_progress/.test(c.sql))).toBe(false);
  });
  it('unhide removes only the "dismissed" tick', async () => {
    const { svc, d } = build();
    await svc.unhide(1);
    expect(d.calls[0].sql).toMatch(/item = 'dismissed'/);
  });
});

describe('InsightsService', () => {
  const terms: any = { getTerms: async () => ({ version: '1.0' }) };
  it('record rejects an event name that is not in the list', async () => {
    await expect(new InsightsService(ds(), terms).record(1, 'u', 'hack')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('record cuts long names and keeps null for a missing step', async () => {
    const d = ds();
    await new InsightsService(d, terms).record(1, 'u'.repeat(300), 'start');
    expect(d.calls[0].params[1]).toHaveLength(100);
    expect(d.calls[0].params[3]).toBeNull();
    await new InsightsService(d, terms).record(1, 'u', 'tour_step', 's'.repeat(99));
    expect(d.calls[1].params[3]).toHaveLength(50);
  });
  it('report: pending-terms total is users minus accepted, never negative', async () => {
    const d = ds([
      [/FROM usermaster WHERE enable_disable/, [{ c: '10' }]],
      [/FROM terms_acceptances t JOIN usermaster/, [{ c: '12' }]],
      [/FROM onboarding_events WHERE step IS NOT NULL/, [{ step: 'welcome', reached: '4', skipped: '1' }]],
      [/ORDER BY accepted_at DESC/, [{ username: 'a', version: '1.0', accepted_at: '2026-10-01T00:00:00Z' }]],
    ]);
    const r = await new InsightsService(d, terms).report();
    expect(r.terms.pendingTotal).toBe(0);
    expect(r.steps).toEqual([{ step: 'welcome', reached: 4, skipped: 1 }]);
    expect(r.terms.recent[0].acceptedAt).toBe('2026-10-01T00:00:00.000Z');
  });
});
