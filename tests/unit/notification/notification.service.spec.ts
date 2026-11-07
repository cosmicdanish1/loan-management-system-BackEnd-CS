import { NotificationService } from '../../../src/modules/notification/services/notification.service';
import { NotificationChannel, NotificationStatus, NotificationType } from '../../../src/modules/notification/entities/notification-log.entity';

type Cfg = Record<string, string | undefined>;

function build(cfg: Cfg = {}, rows: Record<number, any> = {}) {
  const saved: any[] = [];
  const repo: any = {
    findOne: jest.fn(async ({ where }: any) => (where.id !== undefined ? rows[where.id] ?? null : Object.values(rows).find((r: any) => r.dedupeKey === where.dedupeKey) ?? null)),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => { saved.push({ ...x }); return { id: 99, ...x }; }),
    update: jest.fn(async () => ({})),
    count: jest.fn(async () => 0),
  };
  const ds: any = { query: jest.fn(async () => []) };
  const config: any = { get: (k: string) => cfg[k] };
  const svc = new NotificationService(repo, {} as any, ds, config);
  return { svc, repo, ds, saved };
}

const log = (over: any = {}) => ({ id: 1, channel: NotificationChannel.SMS, recipient: '9876543210', message: 'hi', status: NotificationStatus.PENDING, msgRef: 'MSG-X', ...over });

describe('NotificationService', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

  describe('channel status', () => {
    it('reports which providers are configured', () => {
      expect(build({ MSG91_AUTH_KEY: 'k', WHATSAPP_API_KEY: 'w' }).svc.getChannelStatus()).toEqual({ email: false, sms: true, whatsapp: true });
      expect(build().svc.getChannelStatus()).toEqual({ email: false, sms: false, whatsapp: false });
    });
  });

  describe('sendNotification', () => {
    it('an unknown id is reported, not thrown', async () => {
      expect(await build().svc.sendNotification(5)).toEqual({ success: false, error: 'Not found' });
    });

    it('an already SENT message is never sent twice', async () => {
      const { svc } = build({ MSG91_AUTH_KEY: 'k' }, { 1: log({ status: NotificationStatus.SENT }) });
      global.fetch = jest.fn() as any;
      expect((await svc.sendNotification(1)).success).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('a CANCELLED message is not sent', async () => {
      const { svc } = build({ MSG91_AUTH_KEY: 'k' }, { 1: log({ status: NotificationStatus.CANCELLED }) });
      global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as any;
      const r = await svc.sendNotification(1);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(r.success).toBe(false);
    });

    it('SMS: posts to MSG91 with the auth key and strips +91 from the number', async () => {
      const { svc, saved } = build({ MSG91_AUTH_KEY: 'KEY' }, { 1: log({ recipient: '+919876543210' }) });
      global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as any;
      const r = await svc.sendNotification(1);
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toContain('msg91.com');
      expect(init.headers.authkey).toBe('KEY');
      expect(JSON.parse(init.body).sms[0].to).toEqual(['9876543210']);
      expect(r.success).toBe(true);
      expect(saved[0].status).toBe(NotificationStatus.SENT);
      expect(saved[0].sentAt).toBeInstanceOf(Date);
    });

    it('SMS without a configured key fails and is marked FAILED with the reason', async () => {
      const { svc, saved } = build({}, { 1: log() });
      const r = await svc.sendNotification(1);
      expect(r).toEqual({ success: false, error: 'MSG91 not configured' });
      expect(saved[0]).toMatchObject({ status: NotificationStatus.FAILED, errorMessage: 'MSG91 not configured' });
    });

    it('a provider error (HTTP 500) marks the message FAILED with the status and body', async () => {
      const { svc, saved } = build({ MSG91_AUTH_KEY: 'k' }, { 1: log() });
      global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })) as any;
      const r = await svc.sendNotification(1);
      expect(r.success).toBe(false);
      expect(saved[0].errorMessage).toBe('MSG91 500: boom');
    });

    it('a FAILED message can be retried', async () => {
      const { svc } = build({ MSG91_AUTH_KEY: 'k' }, { 1: log({ status: NotificationStatus.FAILED }) });
      global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as any;
      expect((await svc.sendNotification(1)).success).toBe(true);
    });

    it('overrideChannel switches the channel used', async () => {
      const { svc } = build({ WHATSAPP_API_KEY: 'W' }, { 1: log() });
      global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as any;
      await svc.sendNotification(1, NotificationChannel.WHATSAPP);
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('gupshup');
    });

    it('WhatsApp: a 10 digit number gets the 91 prefix', async () => {
      const { svc } = build({ WHATSAPP_API_KEY: 'W' }, { 1: log({ channel: NotificationChannel.WHATSAPP, recipient: '8765432109' }) });
      global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as any;
      await svc.sendNotification(1);
      const body = (global.fetch as jest.Mock).mock.calls[0][1].body as URLSearchParams;
      expect(body.get('destination')).toBe('918765432109');
    });

    it('WhatsApp: a 10 digit mobile number that itself starts with 91 still gets the country code', async () => {
      const { svc } = build({ WHATSAPP_API_KEY: 'W' }, { 1: log({ channel: NotificationChannel.WHATSAPP, recipient: '9123456789' }) });
      global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as any;
      await svc.sendNotification(1);
      const body = (global.fetch as jest.Mock).mock.calls[0][1].body as URLSearchParams;
      expect(body.get('destination')).toBe('919123456789');
    });

    it('WhatsApp: a number already written with 91 (12 digits) is not prefixed twice', async () => {
      const { svc } = build({ WHATSAPP_API_KEY: 'W' }, { 1: log({ channel: NotificationChannel.WHATSAPP, recipient: '919876543210' }) });
      global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as any;
      await svc.sendNotification(1);
      expect(((global.fetch as jest.Mock).mock.calls[0][1].body as URLSearchParams).get('destination')).toBe('919876543210');
    });

    it('email: not configured is a clear failure', async () => {
      const { svc } = build({}, { 1: log({ channel: NotificationChannel.EMAIL, recipient: 'a@b.com' }) });
      expect((await svc.sendNotification(1)).error).toBe('SMTP not configured');
    });
  });

  describe('email template', () => {
    it('escapes HTML in the subject and body and keeps line breaks', () => {
      const { svc } = build();
      const html = (svc as any).buildEmailTemplate('<b>x</b>', 'a<script>alert(1)</script>\nline2 & "q"');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('<br>line2 &amp; &quot;q&quot;');
      expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    });
  });

  describe('sendBatch / cancel', () => {
    it('counts sent and failed', async () => {
      const { svc } = build({ MSG91_AUTH_KEY: 'k' }, { 1: log({ id: 1 }), 2: log({ id: 2, channel: NotificationChannel.EMAIL }) });
      global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as any;
      expect(await svc.sendBatch([1, 2, 3])).toEqual({ sent: 1, failed: 2, total: 3 });
    });

    it('cancel only touches PENDING rows and reports how many it really cancelled', async () => {
      const { svc, repo } = build();
      repo.update.mockResolvedValue({ affected: 1 });
      const r: any = await svc.cancelNotifications([1, 2, 3]);
      expect(repo.update.mock.calls[0][0].status).toBe(NotificationStatus.PENDING);
      expect(r.cancelled).toBe(1);
    });
  });

  describe('queueNotification (dedupe)', () => {
    it('returns the existing row for a repeated dedupe key without inserting', async () => {
      const { svc, repo } = build({}, { 7: { id: 7, dedupeKey: 'K' } });
      const r: any = await svc.queueNotification({ dedupeKey: 'K', message: 'x' } as any);
      expect(r.id).toBe(7);
      expect(repo.save).not.toHaveBeenCalled();
    });
    it('a new message is saved PENDING with a MSG- reference', async () => {
      const { svc, saved } = build();
      await svc.queueNotification({ message: 'x', recipient: '1' } as any);
      expect(saved[0].status).toBe(NotificationStatus.PENDING);
      expect(saved[0].msgRef).toMatch(/^MSG-[0-9A-Z]+-[0-9A-Z]{4}$/);
    });
    it('a unique-constraint race (23505) is treated as a duplicate, not an error', async () => {
      const { svc, repo } = build();
      repo.save.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
      expect(await svc.queueNotification({ dedupeKey: 'K' } as any)).toBeNull();
    });
    it('any other save error is thrown', async () => {
      const { svc, repo } = build();
      repo.save.mockRejectedValue(new Error('disk'));
      await expect(svc.queueNotification({} as any)).rejects.toThrow('disk');
    });
  });

  describe('queueTransactionAlert', () => {
    it('builds the message with the member name and an Indian-format amount, as SMS', async () => {
      const { svc, ds, saved } = build();
      ds.query.mockResolvedValue([{ name: 'Asha Patil', phone: '9000000001' }]);
      await svc.queueTransactionAlert({ memberNo: '1001', transactionType: 'Deposit', amount: 150000 });
      expect(saved[0]).toMatchObject({ channel: NotificationChannel.SMS, type: NotificationType.TRANSACTION, recipient: '9000000001' });
      expect(saved[0].message).toContain('Asha Patil');
      expect(saved[0].message).toContain('1,50,000.00');
    });
    it('looks the member up with a bound parameter', async () => {
      const { svc, ds } = build();
      await svc.queueTransactionAlert({ memberNo: "1'; DROP", transactionType: 'x', amount: 1 });
      expect(ds.query.mock.calls[0][1]).toEqual(["1'; DROP"]);
    });
    it('two different payments of the same amount on the same day each get their own alert', async () => {
      const { svc, ds, repo } = build();
      ds.query.mockResolvedValue([{ name: 'A', phone: '9' }]);
      await svc.queueTransactionAlert({ memberNo: '1', transactionType: 'Deposit', amount: 500 });
      await svc.queueTransactionAlert({ memberNo: '1', transactionType: 'Deposit', amount: 500 });
      const keys = repo.create.mock.calls.map((c: any) => c[0].dedupeKey);
      expect(new Set(keys).size).toBe(2);
    });
    it('a member with no phone number is not queued for SMS', async () => {
      const { svc, ds, repo } = build();
      ds.query.mockResolvedValue([{ name: 'A', phone: null }]);
      await svc.queueTransactionAlert({ memberNo: '1', transactionType: 'Deposit', amount: 5 });
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('scheduled queues', () => {
    it('EMI alerts skip members without a phone and report only the newly queued ones', async () => {
      const { svc, ds, repo } = build({}, { 7: { id: 7, dedupeKey: 'x' } });
      ds.query.mockResolvedValue([{ mbno: '1', name: 'A', phone: '9', amount: '100' }, { mbno: '2', name: 'B', phone: '', amount: '5' }]);
      const r: any = await svc.scheduleEmiAlerts();
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(r).toEqual({ queued: 1, total: 2 });
    });
    it('a repeat run the same day queues nothing new and does not count the duplicates as queued', async () => {
      const { svc, ds, repo } = build();
      ds.query.mockResolvedValue([{ mbno: '1', name: 'A', phone: '9', amount: '100' }]);
      repo.findOne.mockResolvedValue({ id: 5 }); // already queued today
      const r: any = await svc.scheduleEmiAlerts();
      expect(repo.save).not.toHaveBeenCalled();
      expect(r.queued).toBe(0);
    });
    it('maturity alerts read fdmaster and skip closed accounts in SQL', async () => {
      const { svc, ds } = build();
      await svc.scheduleDepositMaturityAlerts();
      expect(ds.query.mock.calls[0][0]).toMatch(/FROM fdmaster/);
      expect(ds.query.mock.calls[0][0]).toMatch(/<> 'C'/);
    });
    it('a database error in a cron is caught and returned, never thrown', async () => {
      const { svc, ds } = build();
      ds.query.mockRejectedValue(new Error('db down'));
      expect(await svc.scheduleEmiAlerts()).toEqual({ queued: 0, error: 'db down' });
    });
    it('monthly summaries go to every active member, not only the first 200', async () => {
      const { svc, ds } = build();
      await svc.scheduleMonthlySummaries().catch(() => undefined);
      // the cron only runs on the last day of the month; force it
      jest.useFakeTimers().setSystemTime(new Date('2026-09-30T10:00:00'));
      ds.query.mockClear();
      await svc.scheduleMonthlySummaries();
      jest.useRealTimers();
      expect(ds.query.mock.calls[0][0]).not.toMatch(/LIMIT 200/);
    });
    it('monthly summaries do nothing on a day that is not the last of the month', async () => {
      const { svc, ds } = build();
      jest.useFakeTimers().setSystemTime(new Date('2026-09-15T10:00:00'));
      await svc.scheduleMonthlySummaries();
      jest.useRealTimers();
      expect(ds.query).not.toHaveBeenCalled();
    });
  });

  describe('queries', () => {
    it('history uses a bound limit and returns [] on error', async () => {
      const { svc, ds } = build();
      await svc.getHistory(50);
      expect(ds.query.mock.calls[0][1]).toEqual([50]);
      ds.query.mockRejectedValue(new Error('x'));
      expect(await svc.getHistory()).toEqual([]);
    });
    it('stats: pendingCount equals totalPending (the bell reads it)', async () => {
      const { svc, repo } = build();
      repo.count.mockImplementation(async ({ where }: any) => ({ PENDING: 3, SENT: 10, FAILED: 2 } as any)[where.status] ?? 0);
      expect(await svc.getStats()).toEqual({ totalPending: 3, totalSent: 10, totalFailed: 2, pendingCount: 3 });
    });
    it('stats fall back to zeros on a database error', async () => {
      const { svc, repo } = build();
      repo.count.mockRejectedValue(new Error('x'));
      expect(await svc.getStats()).toEqual({ totalPending: 0, totalSent: 0, totalFailed: 0, pendingCount: 0 });
    });
  });
});
