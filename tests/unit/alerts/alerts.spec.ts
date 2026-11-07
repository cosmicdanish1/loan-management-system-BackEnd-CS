import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import { AlertService, esc } from '../../../src/modules/alerts/alert.service';
import { AlertSettingsService } from '../../../src/modules/alerts/alert-settings.service';
import { ALERT_CATALOG, ALERT_GROUPS, EXTRA_KEYS } from '../../../src/modules/alerts/alert-catalog';
import { TelegramClientService } from '../../../src/modules/alerts/telegram-client.service';
import { DiscordClientService, htmlToDiscord } from '../../../src/modules/alerts/discord-client.service';
import { AlertBridge } from '../../../src/modules/alerts/alert-bridge';
import { SlowCallInterceptor } from '../../../src/modules/alerts/slow-call.interceptor';

const cfg = (o: Record<string, string> = {}) => ({ get: (k: string, d?: any) => o[k] ?? d }) as any;
const client = { host: 'PC1', ip: '10.0.0.5', mac: 'AA:BB', version: '1.9.0' };

function settingsWith(rows: any[] = []) {
  const ds: any = { query: jest.fn(async (sql: string) => (/FROM alert_settings/.test(sql) ? rows : [])) };
  const s = new AlertSettingsService(ds);
  return { s, ds, load: () => (s as any).reload() };
}

function alertService(over: { tg?: boolean; dc?: boolean; settings?: any; env?: Record<string, string> } = {}) {
  const sent: any[] = [];
  const telegram: any = { isConfigured: () => over.tg ?? true, send: jest.fn(async (t: string, c: string) => { sent.push({ to: 'tg', c, t }); }) };
  const discord: any = { isConfigured: () => over.dc ?? false, anyConfigured: () => over.dc ?? false, send: jest.fn(async (t: string, c: string) => { sent.push({ to: 'dc', c, t }); }) };
  const settings: any = over.settings ?? { isEnabled: () => true, destinations: () => ({ telegram: true, discord: true }), param: (k: string) => ({ 'login.failed': 3, 'presence.offline': 3, 'error.slow': 5 } as any)[k] ?? 0 };
  const svc = new AlertService(cfg(over.env), telegram, settings, discord);
  return { svc, sent, telegram, discord, settings };
}
const flush = () => new Promise((r) => setImmediate(r));

describe('alert catalogue', () => {
  it('keys are unique and every alert belongs to a real group', () => {
    const keys = ALERT_CATALOG.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of ALERT_CATALOG) expect(ALERT_GROUPS.map((g) => g.id)).toContain(a.group);
  });
  it('every threshold has a default inside its own min/max', () => {
    for (const a of ALERT_CATALOG.filter((x) => x.param)) {
      expect(a.param!.default).toBeGreaterThanOrEqual(a.param!.min);
      expect(a.param!.default).toBeLessThanOrEqual(a.param!.max);
    }
  });
  it('extra switches do not clash with alert keys', () => {
    for (const k of EXTRA_KEYS) expect(ALERT_CATALOG.some((a) => a.key === k)).toBe(false);
  });
});

describe('AlertSettingsService', () => {
  it('before anything is stored everything is on and thresholds use their defaults', () => {
    const { s } = settingsWith();
    expect(s.isEnabled('login.success')).toBe(true);
    expect(s.param('login.failed')).toBe(3);
    expect(s.destinations('error.backend')).toEqual({ telegram: true, discord: true });
  });
  it('the master switch silences every alert but not the plain flags', async () => {
    const { s, load } = settingsWith([{ key: 'master', enabled: false, param: null, telegram: true, discord: true }]);
    await load();
    expect(s.isEnabled('login.success')).toBe(false);
    expect(s.destinations('login.success')).toEqual({ telegram: false, discord: false });
    expect(s.flag('jira.create')).toBe(true);
  });
  it('a destination switch turns off only that destination', async () => {
    const { s, load } = settingsWith([{ key: 'dest.discord', enabled: false, param: null, telegram: true, discord: true }]);
    await load();
    expect(s.destinations('logout')).toEqual({ telegram: true, discord: false });
  });
  it('an alert\'s own destination switches are honoured', async () => {
    const { s, load } = settingsWith([{ key: 'logout', enabled: true, param: null, telegram: false, discord: true }]);
    await load();
    expect(s.destinations('logout')).toEqual({ telegram: false, discord: true });
  });
  it('a threshold is read back as a number', async () => {
    const { s, load } = settingsWith([{ key: 'login.failed', enabled: true, param: '5', telegram: true, discord: true }]);
    await load();
    expect(s.param('login.failed')).toBe(5);
  });
  describe('update', () => {
    it('rejects a key that is not in the catalogue', async () => {
      await expect(settingsWith().s.update('nope', { enabled: false }, 'admin')).rejects.toBeInstanceOf(BadRequestException);
    });
    it('rejects a threshold on an alert that has none, and one outside its range', async () => {
      const { s } = settingsWith();
      await expect(s.update('logout', { param: 5 }, 'a')).rejects.toBeInstanceOf(BadRequestException);
      await expect(s.update('login.failed', { param: 0 }, 'a')).rejects.toBeInstanceOf(BadRequestException);
      await expect(s.update('login.failed', { param: 51 }, 'a')).rejects.toBeInstanceOf(BadRequestException);
      await expect(s.update('login.failed', { param: NaN }, 'a')).rejects.toBeInstanceOf(BadRequestException);
    });
    it('the plain switches only have an on/off', async () => {
      const { s } = settingsWith();
      await expect(s.update('master', { telegram: false }, 'a')).rejects.toBeInstanceOf(BadRequestException);
      await expect(s.update('master', { enabled: false }, 'a')).resolves.toBeUndefined();
    });
    it('a partial update keeps the other values and saves with bound parameters', async () => {
      const { s, ds } = settingsWith();
      await s.update('login.failed', { param: 7 }, 'admin');
      await s.update('login.failed', { enabled: false }, 'admin');
      expect(ds.query.mock.calls.at(-1)[1]).toEqual(['login.failed', false, 7, true, true, 'admin']);
      expect(s.param('login.failed')).toBe(7);
    });
    it('updateGroup changes every alert of the group', async () => {
      const { s, ds } = settingsWith();
      await s.updateGroup('activity', false, 'admin');
      expect(ds.query).toHaveBeenCalledTimes(ALERT_CATALOG.filter((a) => a.group === 'activity').length);
      await expect(s.updateGroup('bogus' as any, true, 'a')).rejects.toBeInstanceOf(BadRequestException);
    });
    it('switching a destination on for a group also clears a mute; switching off leaves the mute alone', async () => {
      const { s, ds } = settingsWith();
      await s.updateGroupDest('business', 'discord', true, 'a');
      expect(ds.query.mock.calls[0][1].slice(1, 5)).toEqual([true, null, true, true]);
      ds.query.mockClear();
      await s.updateGroupDest('business', 'discord', false, 'a');
      expect(ds.query.mock.calls[0][1][4]).toBe(false);
    });
  });
});

describe('esc / htmlToDiscord', () => {
  it('escapes the three HTML characters and tolerates null', () => {
    expect(esc('<b>&')).toBe('&lt;b&gt;&amp;');
    expect(esc(null)).toBe('');
  });
  it('turns Telegram HTML into Discord markdown and un-escapes entities once', () => {
    expect(htmlToDiscord('<b>Hi</b> <i>x</i> <code>c</code> &lt;a&gt; &amp;lt;')).toBe('**Hi** *x* `c` <a> &lt;');
  });
  it('drops unknown tags', () => {
    expect(htmlToDiscord('a<u>b</u>')).toBe('ab');
  });
});

describe('AlertService', () => {
  afterEach(() => AlertBridge.set(undefined as any));

  describe('sending', () => {
    it('nothing is sent when ALERTS_ENABLED=false', async () => {
      const { svc, sent } = alertService({ env: { ALERTS_ENABLED: 'false' } });
      svc.dayEndDone({ date: '2026-10-30', seconds: 5 });
      await flush();
      expect(sent).toHaveLength(0);
    });
    it('a switched-off alert is not sent', async () => {
      const { svc, sent } = alertService({ settings: { isEnabled: () => false, destinations: () => ({ telegram: false, discord: false }), param: () => 3 } });
      svc.dayEndDone({ date: 'd', seconds: 1 });
      await flush();
      expect(sent).toHaveLength(0);
    });
    it('goes to every configured destination that is on', async () => {
      const { svc, sent } = alertService({ dc: true });
      svc.dayEndDone({ date: 'd', seconds: 1 });
      await flush();
      expect(sent.map((s) => s.to).sort()).toEqual(['dc', 'tg']);
      expect(sent[0].c).toBe('business');
    });
    it('non-production installs are tagged', async () => {
      const { svc, sent } = alertService({ env: { ALERT_ENV: 'staging' } });
      svc.dayEndDone({ date: 'd', seconds: 1 });
      await flush();
      expect(sent[0].t).toContain('[staging]');
    });
    it('production messages carry no tag', async () => {
      const { svc, sent } = alertService({ env: { ALERT_ENV: 'production' } });
      svc.dayEndDone({ date: 'd', seconds: 1 });
      await flush();
      expect(sent[0].t.startsWith('✅')).toBe(true);
    });
    it('user text is HTML-escaped in the message', async () => {
      const { svc, sent } = alertService();
      svc.userCreated({ by: '<script>', username: 'a&b' });
      await flush();
      expect(sent[0].t).toContain('&lt;script&gt;');
      expect(sent[0].t).toContain('a&amp;b');
    });
    it('a failing Telegram send never throws to the caller and the next alert still goes out', async () => {
      const { svc, telegram, sent } = alertService();
      telegram.send.mockRejectedValueOnce(new Error('429'));
      svc.dayEndDone({ date: 'a', seconds: 1 });
      await flush();
      svc.dayEndDone({ date: 'b', seconds: 1 });
      await flush();
      expect(sent.length).toBeGreaterThanOrEqual(1);
    });
    it('the queue never grows past 200 (the oldest are dropped)', () => {
      const { svc } = alertService();
      (svc as any).draining = true; // stop it draining so the queue can fill
      for (let i = 0; i < 500; i++) svc.dayEndDone({ date: String(i), seconds: 1 });
      expect((svc as any).queue.length).toBe(200);
      expect((svc as any).queue[199].text).toContain('499');
    });
  });

  describe('errors / slow / crashes', () => {
    it('the first occurrence is sent at once, repeats are not', async () => {
      const { svc, sent } = alertService();
      for (let i = 0; i < 5; i++) svc.reportServerError({ method: 'GET', route: '/x', status: 500, message: 'boom', user: 'u' });
      await flush();
      expect(sent).toHaveLength(1);
      expect(svc.snapshot().errors).toBe(5);
    });
    it('different messages are different problems', async () => {
      jest.useFakeTimers();
      const { svc, sent } = alertService();
      svc.reportServerError({ method: 'GET', route: '/x', status: 500, message: 'a' });
      svc.reportServerError({ method: 'GET', route: '/x', status: 500, message: 'b' });
      await jest.advanceTimersByTimeAsync(10000); // sends are spaced 3.2 s apart
      jest.useRealTimers();
      expect(sent).toHaveLength(2);
    });
    it('the periodic flush summarises the repeats once', async () => {
      const { svc, sent } = alertService();
      for (let i = 0; i < 4; i++) svc.reportServerError({ method: 'GET', route: '/x', status: 500, message: 'boom' });
      await flush();
      jest.useFakeTimers();
      (svc as any).flush();
      await jest.advanceTimersByTimeAsync(10000);
      jest.useRealTimers();
      expect(sent).toHaveLength(2);
      expect(sent[1].t).toContain('×4');
      expect(sent[1].t).toContain('+3');
      (svc as any).flush();
      await flush();
      expect(sent).toHaveLength(2); // nothing new, no second summary
    });
    it('counters still count when the alert itself is muted', () => {
      const { svc } = alertService({ settings: { isEnabled: () => false, destinations: () => ({ telegram: false, discord: false }), param: () => 3 } });
      svc.reportServerError({ method: 'GET', route: '/x', status: 500, message: 'boom' });
      svc.reportSlowCall({ method: 'GET', route: '/x', ms: 9000 });
      svc.reportClientCrash({ host: 'h', route: '/r', message: 'm' });
      expect(svc.snapshot()).toMatchObject({ errors: 1, slow: 1, slowMax: 9000, crashes: 1 });
    });
    it('slow calls: a clean first message with seconds, user optional', async () => {
      const { svc, sent } = alertService();
      svc.reportSlowCall({ method: 'POST', route: '/reports', ms: 6400 });
      await flush();
      expect(sent[0].t).toContain('6.4 s');
    });
    it('the slow limit comes from Settings in seconds', () => {
      expect(alertService().svc.slowThresholdMs()).toBe(5000);
    });
    it('a very long error message is cut to 160 characters', async () => {
      const { svc, sent } = alertService();
      svc.reportServerError({ method: 'GET', route: '/x', status: 500, message: 'm'.repeat(1000) });
      await flush();
      expect(sent[0].t.length).toBeLessThan(500);
    });
  });

  describe('failed logins', () => {
    const fail = (svc: AlertService, n: number, user = 'Admin') => { for (let i = 0; i < n; i++) svc.loginFailed({ username: user, client }); };
    it('alerts on the 3rd failure, not before', async () => {
      const { svc, sent } = alertService();
      fail(svc, 2);
      await flush();
      expect(sent).toHaveLength(0);
      fail(svc, 1);
      await flush();
      expect(sent).toHaveLength(1);
      expect(sent[0].t).toContain('3 failed logins');
    });
    it('then again at 13, not at every attempt', async () => {
      const { svc, sent } = alertService();
      fail(svc, 12);
      await flush();
      expect(sent).toHaveLength(1);
      jest.useFakeTimers();
      fail(svc, 1);
      await jest.advanceTimersByTimeAsync(10000);
      jest.useRealTimers();
      expect(sent).toHaveLength(2);
    });
    it('user name case does not split the count', async () => {
      const { svc, sent } = alertService();
      svc.loginFailed({ username: 'ADMIN', client });
      svc.loginFailed({ username: 'admin', client });
      svc.loginFailed({ username: 'Admin', client });
      await flush();
      expect(sent).toHaveLength(1);
    });
    it('a successful login resets the count for that account and PC', async () => {
      const { svc, sent } = alertService();
      fail(svc, 2);
      svc.loginOk({ userId: 1, username: 'Admin', client });
      await flush();
      sent.length = 0;
      fail(svc, 2);
      await flush();
      expect(sent).toHaveLength(0);
    });
    it('a blank user name is shown as (blank)', async () => {
      const { svc, sent } = alertService();
      fail(svc, 3, '');
      await flush();
      expect(sent[0].t).toContain('(blank)');
    });
  });

  describe('who is online', () => {
    it('login makes the user online, logout removes that PC only', () => {
      const { svc } = alertService();
      svc.loginOk({ userId: 1, username: 'a', client });
      svc.loginOk({ userId: 1, username: 'a', client: { ...client, host: 'PC2' } });
      expect(svc.onlineNow()).toHaveLength(2);
      svc.logout({ userId: 1, username: 'a', client });
      expect(svc.onlineNow().map((p) => p.host)).toEqual(['PC2']);
    });
    it('a logout without a PC name removes every PC of that user and nobody else', () => {
      const { svc } = alertService();
      svc.loginOk({ userId: 1, username: 'a', client });
      svc.loginOk({ userId: 1, username: 'a', client: { ...client, host: 'PC2' } });
      svc.loginOk({ userId: 2, username: 'b', client });
      svc.logout({ userId: 1, username: 'a', client: { host: '', ip: '', mac: '', version: '' } });
      expect(svc.onlineNow().map((p) => p.username)).toEqual(['b']);
    });
    it('a heartbeat keeps a user online and records the peak', () => {
      const { svc } = alertService();
      svc.heartbeat({ userId: 1, username: 'a', client });
      svc.heartbeat({ userId: 2, username: 'b', client });
      svc.heartbeat({ userId: 1, username: 'a', client });
      expect(svc.onlineNow()).toHaveLength(2);
      expect(svc.snapshot().peakOnline).toBe(2);
    });
    it('a user silent for longer than the limit goes offline with one alert', async () => {
      const { svc, sent } = alertService();
      jest.useFakeTimers().setSystemTime(new Date('2026-10-30T10:00:00'));
      svc.loginOk({ userId: 1, username: 'a', client });
      await jest.advanceTimersByTimeAsync(1000);
      sent.length = 0;
      jest.setSystemTime(new Date('2026-10-30T10:10:00'));
      svc.sweepPresence();
      await jest.advanceTimersByTimeAsync(10000);
      jest.useRealTimers();
      expect(svc.onlineNow()).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(sent[0].t).toContain('went offline');
    });
    it('the online snapshot says nobody is signed in when the list is empty', async () => {
      const { svc, sent } = alertService();
      expect(svc.sendOnlineSnapshot()).toBe(0);
      await flush();
      expect(sent[0].t).toContain('Nobody is signed in');
    });
  });

  describe('digest counters', () => {
    it('takeStats hands over the counters and starts a fresh day', () => {
      const { svc } = alertService();
      svc.loginOk({ userId: 1, username: 'a', client });
      svc.loginOk({ userId: 1, username: 'a', client });
      expect(svc.takeStats()).toMatchObject({ logins: 2, users: ['a'] });
      expect(svc.snapshot()).toMatchObject({ logins: 0, users: [] });
    });
    it('restore ignores a malformed saved state', () => {
      const { svc } = alertService();
      svc.restore({ hourly: [1, 2] } as any);
      expect(svc.snapshot().hourly).toHaveLength(24);
    });
    it('restore keeps a valid saved state', () => {
      const { svc } = alertService();
      svc.restore({ ...AlertService.emptyStats(), logins: 9 });
      expect(svc.snapshot().logins).toBe(9);
    });
  });

  describe('business messages', () => {
    it('backup OK shows the size in MB, a failure shows the (cut) reason', async () => {
      jest.useFakeTimers();
      const { svc, sent } = alertService();
      svc.backupResult({ ok: true, sizeBytes: 5 * 1024 * 1024 });
      svc.backupResult({ ok: false, error: 'x'.repeat(500) });
      await jest.advanceTimersByTimeAsync(10000);
      jest.useRealTimers();
      expect(sent[0].t).toContain('5 MB');
      expect(sent[1].t.length).toBeLessThan(400);
    });
    it('licence message differs for expired and expiring (singular day)', async () => {
      jest.useFakeTimers();
      const { svc, sent } = alertService();
      svc.licenceExpiring(1, '2026-11-01');
      svc.licenceExpiring(0, '2026-11-01');
      await jest.advanceTimersByTimeAsync(10000);
      jest.useRealTimers();
      expect(sent[0].t).toContain('expires in 1 day');
      expect(sent[0].t).not.toContain('1 days');
      expect(sent[1].t).toContain('has expired');
    });
    it('userChanged with nothing changed sends nothing', async () => {
      const { svc, sent } = alertService();
      svc.userChanged({ by: 'a', username: 'b', changes: [] });
      await flush();
      expect(sent).toHaveLength(0);
    });
    it('the AlertBridge hands the service to code that is not built by Nest', () => {
      const { svc } = alertService();
      svc.onModuleInit();
      expect(AlertBridge.get()).toBe(svc);
      svc.onModuleDestroy();
    });
  });
});

describe('TelegramClientService', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.useRealTimers(); });
  const tg = (o: Record<string, string> = {}) => new TelegramClientService(cfg({ TELEGRAM_BOT_TOKEN: 'TOKEN123', TELEGRAM_CHAT_ID: '-100', ...o }));

  it('needs both a token and a chat id', () => {
    expect(tg().isConfigured()).toBe(true);
    expect(tg({ TELEGRAM_BOT_TOKEN: '' }).isConfigured()).toBe(false);
  });
  it('a topic id is used only when it is a positive whole number', async () => {
    global.fetch = jest.fn(async () => ({ ok: true })) as any;
    await tg({ TELEGRAM_TOPIC_ERRORS: '42' }).send('x', 'errors');
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).message_thread_id).toBe(42);
    await tg({ TELEGRAM_TOPIC_ERRORS: 'abc' }).send('x', 'errors');
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body).message_thread_id).toBeUndefined();
  });
  it('a 4xx answer is not retried and the error never contains the bot token', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 400, text: async () => 'bad request' })) as any;
    const err: Error = await tg().send('x').catch((e) => e);
    expect(err.message).toContain('Telegram 400');
    expect(err.message).not.toContain('TOKEN123');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('a 500 is retried up to three times then fails', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(async () => ({ ok: false, status: 502, text: async () => '<html>bad gateway</html>' })) as any;
    const p = tg().send('x').catch((e) => e);
    await jest.advanceTimersByTimeAsync(10000);
    const err: Error = await p;
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(err.message).toContain('Telegram 502');
  });
  it('a long message is cut at 4000 characters without breaking an HTML tag in half', async () => {
    global.fetch = jest.fn(async () => ({ ok: true })) as any;
    await tg().send('<b>' + 'x'.repeat(3995) + '</b> tail', 'queries', 'HTML');
    const text: string = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).text;
    const opens = (text.match(/<b>/g) || []).length;
    const closes = (text.match(/<\/b>/g) || []).length;
    expect(opens).toBe(closes);
  });
});

describe('DiscordClientService', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const URL_OK = 'https://discord.com/api/webhooks/123456/abc-DEF_1';
  const dc = (o: Record<string, string> = {}) => new DiscordClientService(cfg(o));

  it('accepts only real Discord webhook URLs', () => {
    expect(dc({ DISCORD_WEBHOOK_URL: URL_OK }).anyConfigured()).toBe(true);
    for (const bad of ['http://discord.com/api/webhooks/1/a', 'https://evil.com/api/webhooks/1/a', 'https://discord.com.evil.com/api/webhooks/1/a', 'https://discord.com/api/webhooks/x/a']) {
      expect(dc({ DISCORD_WEBHOOK_URL: bad }).anyConfigured()).toBe(false);
    }
  });
  it('a channel webhook beats the single fallback', () => {
    const c = dc({ DISCORD_WEBHOOK_ERRORS: 'https://discord.com/api/webhooks/9/z', DISCORD_WEBHOOK_URL: URL_OK });
    expect((c as any).urlFor('errors')).toContain('/9/z');
    expect((c as any).urlFor('queries')).toContain('/123456/');
  });
  it('the card never pings @everyone and the first line is the title', async () => {
    global.fetch = jest.fn(async () => ({ ok: true })) as any;
    await dc({ DISCORD_WEBHOOK_URL: URL_OK }).send('<b>Title</b>\nbody @everyone', 'errors');
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0].title).toBe('Title');
    expect(body.embeds[0].description).toBe('body @everyone');
  });
  it('a 4xx is not retried and the secret webhook URL is not in the error', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404, text: async () => 'Unknown Webhook' })) as any;
    const err: Error = await dc({ DISCORD_WEBHOOK_URL: URL_OK }).send('x', 'errors').catch((e) => e);
    expect(err.message).toBe('Discord 404: Unknown Webhook');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('sending with no webhook configured does nothing', async () => {
    global.fetch = jest.fn() as any;
    await dc().send('x', 'errors');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('SlowCallInterceptor', () => {
  const ctx = (path: string) => ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ method: 'GET', originalUrl: path, user: { username: 'u' } }) }) }) as any;
  const run = async (path: string, ms: number) => {
    const report = jest.fn();
    AlertBridge.set({ slowThresholdMs: () => 1000, reportSlowCall: report } as any);
    jest.useFakeTimers().setSystemTime(new Date('2026-10-30T10:00:00'));
    const obs = new SlowCallInterceptor().intercept(ctx(path), { handle: () => { jest.setSystemTime(new Date(Date.now() + ms)); return of(1); } } as any);
    await new Promise<void>((res) => obs.subscribe({ complete: () => res() }));
    jest.useRealTimers();
    AlertBridge.set(undefined as any);
    return report;
  };
  it('reports a call slower than the limit, with numeric ids turned into :id', async () => {
    const r = await run('/members/123/ledger?x=1', 2500);
    expect(r).toHaveBeenCalledWith({ method: 'GET', route: '/members/:id/ledger', ms: 2500, user: 'u' });
  });
  it('ignores fast calls', async () => {
    expect(await run('/x', 100)).not.toHaveBeenCalled();
  });
  it('ignores jobs that are slow by design', async () => {
    for (const p of ['/backup/create', '/day-end/run', '/demand/import']) expect(await run(p, 9000)).not.toHaveBeenCalled();
  });
  it('does nothing for non-HTTP contexts', () => {
    const h = { handle: jest.fn(() => of(1)) };
    new SlowCallInterceptor().intercept({ getType: () => 'rpc' } as any, h as any);
    expect(h.handle).toHaveBeenCalled();
  });
});
