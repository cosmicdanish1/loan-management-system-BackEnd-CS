import { NotificationService } from '../../../src/modules/notification/services/notification.service';
import { NotificationChannel, NotificationStatus } from '../../../src/modules/notification/entities/notification-log.entity';

function build(cfg: Record<string, string> = {}, rows: Record<number, any> = {}) {
  const repo: any = {
    findOne: jest.fn(async ({ where }: any) => (where.id !== undefined ? rows[where.id] ?? null : Object.values(rows).find((r: any) => r.dedupeKey === where.dedupeKey) ?? null)),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => ({ id: 99, ...x })),
    update: jest.fn(async () => ({ affected: 0 })),
    count: jest.fn(async () => 0),
  };
  const ds: any = { query: jest.fn(async () => []) };
  const svc = new NotificationService(repo, {} as any, ds, { get: (k: string) => cfg[k] } as any);
  return { svc, repo, ds };
}
const log = (o: any = {}) => ({ id: 1, channel: NotificationChannel.WHATSAPP, recipient: '9876543210', message: 'hi', status: NotificationStatus.PENDING, msgRef: 'M', ...o });

describe('notification fixes (ES-430)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.useRealTimers(); });

  describe('WhatsApp number', () => {
    const dest = async (recipient: string) => {
      const { svc } = build({ WHATSAPP_API_KEY: 'W' }, { 1: log({ recipient }) });
      global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as any;
      await svc.sendNotification(1);
      return ((global.fetch as jest.Mock).mock.calls[0][1].body as URLSearchParams).get('destination');
    };
    it('10 digits get 91, including a mobile number that starts with 91', async () => {
      expect(await dest('9876543210')).toBe('919876543210');
      expect(await dest('9123456789')).toBe('919123456789');
    });
    it('a number already written with 91, with +, spaces or dashes, or with a leading 0, ends up as 91 + 10 digits', async () => {
      expect(await dest('919876543210')).toBe('919876543210');
      expect(await dest('+91 98765-43210')).toBe('919876543210');
      expect(await dest('09876543210')).toBe('919876543210');
    });
  });

  describe('cancelled messages and the cancel count', () => {
    it('Send, Retry and batches skip a cancelled message and report it as not sent', async () => {
      const { svc } = build({ MSG91_AUTH_KEY: 'k' }, { 1: log({ channel: NotificationChannel.SMS, status: NotificationStatus.CANCELLED }) });
      global.fetch = jest.fn() as any;
      expect(await svc.sendNotification(1)).toEqual({ success: false, error: 'Message was cancelled' });
      expect(await svc.sendBatch([1])).toEqual({ sent: 0, failed: 1, total: 1 });
      expect(global.fetch).not.toHaveBeenCalled();
    });
    it('cancel reports the rows that were really changed', async () => {
      const { svc, repo } = build();
      repo.update.mockResolvedValue({ affected: 2 });
      expect(await svc.cancelNotifications([1, 2, 3, 4])).toEqual({ cancelled: 2 });
      repo.update.mockResolvedValue({});
      expect(await svc.cancelNotifications([1])).toEqual({ cancelled: 0 });
    });
  });

  describe('transaction alerts', () => {
    const member = (ds: any, phone: string | null) => ds.query.mockResolvedValue([{ name: 'A', phone }]);
    it('the same reference sent twice is one alert; a different reference is another', async () => {
      const { svc, ds, repo } = build(); member(ds, '9');
      await svc.queueTransactionAlert({ memberNo: '1', transactionType: 'Deposit', amount: 500, reference: 'R001' });
      await svc.queueTransactionAlert({ memberNo: '1', transactionType: 'Deposit', amount: 500, reference: 'R001' });
      await svc.queueTransactionAlert({ memberNo: '1', transactionType: 'Deposit', amount: 500, reference: 'R002' });
      const keys = repo.create.mock.calls.map((c: any) => c[0].dedupeKey);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
    });
    it('a phone number from the request is used when the member has none, and nothing is queued when there is no number at all', async () => {
      const a = build(); member(a.ds, null);
      await a.svc.queueTransactionAlert({ memberNo: '1', transactionType: 'Deposit', amount: 5, recipient: '9000000001' });
      expect(a.repo.save).toHaveBeenCalledTimes(1);
      const b = build(); member(b.ds, '   ');
      expect(await b.svc.queueTransactionAlert({ memberNo: '1', transactionType: 'Deposit', amount: 5 })).toBeNull();
      expect(b.repo.save).not.toHaveBeenCalled();
    });
  });

  describe('scheduled queues', () => {
    it('queued counts only new messages: 2 new + 1 already queued = 2', async () => {
      const { svc, ds, repo } = build({}, { 7: { id: 7, dedupeKey: 'x' } });
      ds.query.mockResolvedValue([{ mbno: '1', name: 'A', phone: '9', amount: '1' }, { mbno: '2', name: 'B', phone: '8', amount: '2' }, { mbno: '3', name: 'C', phone: '7', amount: '3' }]);
      repo.findOne.mockImplementationOnce(async () => null).mockImplementationOnce(async () => ({ id: 5 })).mockImplementationOnce(async () => null);
      expect(await svc.scheduleEmiAlerts()).toEqual({ queued: 2, total: 3 });
    });
    it('maturity alerts count only new messages as well', async () => {
      const { svc, ds, repo } = build();
      ds.query.mockResolvedValue([{ mbno: '1', acc_no: 'A1', type: 'FD', mat_date: '2026-11-10', name: 'A', phone: '9' }]);
      repo.findOne.mockResolvedValue({ id: 5 });
      expect(await svc.scheduleDepositMaturityAlerts()).toEqual({ queued: 0, total: 1 });
    });
    it('month-end summaries read every active member in a stable order and queue one message each', async () => {
      const { svc, ds, repo } = build();
      jest.useFakeTimers().setSystemTime(new Date('2026-09-30T22:00:00'));
      const many = Array.from({ length: 450 }, (_, i) => ({ mbno: String(1000 + i), name: 'M' + i, phone: '9' + i }));
      ds.query.mockResolvedValue(many);
      await svc.scheduleMonthlySummaries();
      expect(ds.query.mock.calls[0][0]).toMatch(/ORDER BY m\.mbno/);
      expect(ds.query.mock.calls[0][0]).not.toMatch(/LIMIT/);
      expect(repo.save).toHaveBeenCalledTimes(450);
    });
    it('a repeat of the month-end run does not message anyone twice', async () => {
      const { svc, ds, repo } = build();
      jest.useFakeTimers().setSystemTime(new Date('2026-09-30T22:00:00'));
      ds.query.mockResolvedValue([{ mbno: '1', name: 'A', phone: '9' }]);
      repo.findOne.mockResolvedValue({ id: 5 });
      await svc.scheduleMonthlySummaries();
      expect(repo.save).not.toHaveBeenCalled();
    });
  });
});
