import { NotFoundException } from '@nestjs/common';
import { NotificationCentreService } from '../../../src/modules/notification-centre/notification-centre.service';

// Each detector query is recognised by a fragment of its SQL; anything not listed returns no rows.
function build(routes: Array<[RegExp, any]> = []) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const run = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    for (const [re, rows] of routes) if (re.test(sql)) return typeof rows === 'function' ? rows(sql, params) : rows;
    return [];
  });
  const em = { query: run };
  const ds: any = { query: run, transaction: jest.fn(async (fn: any) => fn(em)) };
  return { svc: new NotificationCentreService(ds), ds, calls, run };
}

const detect = (svc: any) => svc.detect() as Promise<any[]>;

describe('NotificationCentreService', () => {
  describe('detectors', () => {
    it('nothing to report gives no notifications', async () => {
      expect(await detect(build().svc)).toEqual([]);
    });

    it('a retired member with zero RD is flagged "can be marked inactive" with a dedupe key per member', async () => {
      const { svc } = build([[/AS retired_on/, [{ mbno: '1001', name: 'Asha', retired_on: '2026-08-31' }]]]);
      const out = await detect(svc);
      expect(out[0]).toMatchObject({ kind: 'MEMBER_READY_INACTIVE', dedupe_key: 'ready:1001', mbno: '1001' });
      expect(out[0].body).toContain('31-08-2026');
    });

    it('retiring within 30 days is a warning, later is info, and a single day is not pluralised', async () => {
      const { svc } = build([[/AS retires_on/, [
        { mbno: '1', name: 'A', retires_on: '2026-11-10', days_left: 1, rd: 0 },
        { mbno: '2', name: 'B', retires_on: '2026-12-20', days_left: 50, rd: 1500 },
      ]]]);
      const out = await detect(svc);
      expect(out[0].severity).toBe('warning');
      expect(out[0].title).toContain('1 day');
      expect(out[0].title).not.toContain('1 days');
      expect(out[1].severity).toBe('info');
      expect(out[1].body).toContain('₹1,500');
    });

    it('members without a retirement date are reported once, as a count', async () => {
      const out = await detect(build([[/count\(\*\)::int AS n FROM member_master/, [{ n: 1234 }]]]).svc);
      expect(out[0]).toMatchObject({ kind: 'MEMBER_NO_RETIREMENT_DATE', dedupe_key: 'no-retirement-date' });
      expect(out[0].title).toContain('1,234');
    });

    it('group insurance not posted: a warning while the year is ending, an error once it is over', async () => {
      const row = (days_left: number) => [{ yearcode: 2627, fy_start: '2026-04-01', fy_end: '2027-03-31', days_left, posted: false }];
      const soon = await detect(build([[/FROM yearend y/, row(20)]]).svc);
      expect(soon[0]).toMatchObject({ kind: 'INSURANCE_DUE', severity: 'warning', dedupe_key: 'insurance:2627' });
      expect(soon[0].title).toContain('2026-27');
      const over = await detect(build([[/FROM yearend y/, row(-5)]]).svc);
      expect(over[0].severity).toBe('error');
    });

    it('no insurance alert when it is posted, or when the year end is more than 60 days away', async () => {
      expect(await detect(build([[/FROM yearend y/, [{ yearcode: 1, fy_start: '2026-04-01', fy_end: '2027-03-31', days_left: 20, posted: true }]]]).svc)).toEqual([]);
      expect(await detect(build([[/FROM yearend y/, [{ yearcode: 1, fy_start: '2026-04-01', fy_end: '2027-03-31', days_left: 200, posted: false }]]]).svc)).toEqual([]);
    });

    it('negative RD balances give one notification with the total', async () => {
      const out = await detect(build([[/WHERE cd < 0/, [{ n: 3, total: 4500 }]]]).svc);
      expect(out[0]).toMatchObject({ kind: 'NEGATIVE_RD', dedupe_key: 'negative-rd' });
      expect(out[0].title).toContain('3 members have');
      expect(out[0].body).toContain('₹4,500');
    });

    it('failed and stuck messages are two separate notifications', async () => {
      const out = await detect(build([[/FROM notification_logs/, [{ failed: 2, pending: 1 }]]]).svc);
      expect(out.map((o) => o.kind)).toEqual(['MESSAGES_FAILED', 'MESSAGES_PENDING']);
      expect(out[0].severity).toBe('error');
      expect(out[1].title).toContain('1 message is');
    });

    it('day-end: only two or more days behind is reported', async () => {
      expect(await detect(build([[/FROM getworkingdate/, [{ working_date: '2026-10-30', behind: 1 }]]]).svc)).toEqual([]);
      const out = await detect(build([[/FROM getworkingdate/, [{ working_date: '2026-10-28', behind: 4 }]]]).svc);
      expect(out[0]).toMatchObject({ kind: 'DAYEND_PENDING', dedupe_key: 'dayend' });
      expect(out[0].body).toContain('28-10-2026');
    });
  });

  describe('sync', () => {
    it('upserts what is wanted and resolves what no longer holds, in one transaction', async () => {
      const { svc, ds, calls } = build([
        [/AS retired_on/, [{ mbno: '1', name: 'A', retired_on: '2026-08-31' }]],
        [/SET status = 'RESOLVED'/, [[{ id: 5 }, { id: 6 }], 2]],
      ]);
      const r = await svc.sync();
      expect(ds.transaction).toHaveBeenCalledTimes(1);
      expect(r).toEqual({ open: 1, resolved: 2 });
      const upsert = calls.find((c) => /ON CONFLICT \(dedupe_key\)/.test(c.sql))!;
      expect(JSON.parse(upsert.params[0])[0].dedupe_key).toBe('ready:1');
      const resolve = calls.find((c) => /SET status = 'RESOLVED'/.test(c.sql))!;
      expect(resolve.params[0]).toEqual(['ready:1']);
    });

    it('when nothing is wanted every open notification is resolved', async () => {
      const { svc, calls } = build();
      await svc.sync();
      const resolve = calls.find((c) => /SET status = 'RESOLVED'/.test(c.sql))!;
      expect(resolve.params[0]).toEqual([]);
    });

    it('a condition that came back after being resolved loses its read marks (shows as unread again)', async () => {
      const { svc, calls } = build();
      await svc.sync();
      expect(calls[calls.findIndex((c) => /DELETE FROM system_notification_reads/.test(c.sql))].sql).toMatch(/status = 'RESOLVED'/);
    });

    it('two simultaneous syncs share one run', async () => {
      const { svc, ds } = build();
      await Promise.all([svc.sync(), svc.sync()]);
      expect(ds.transaction).toHaveBeenCalledTimes(1);
    });

    it('long titles are cut to 200 characters before saving', async () => {
      const { svc, calls } = build([[/AS retired_on/, [{ mbno: '1', name: 'N'.repeat(400), retired_on: '2026-08-31' }]]]);
      await svc.sync();
      const rows = JSON.parse(calls.find((c) => /ON CONFLICT \(dedupe_key\)/.test(c.sql))!.params[0]);
      expect(rows[0].title.length).toBeLessThanOrEqual(200);
      expect(rows[0].member_name.length).toBeLessThanOrEqual(200);
    });

    it('scheduledSync swallows a failure', async () => {
      const { svc, ds } = build();
      ds.query.mockRejectedValue(new Error('db'));
      await expect(svc.scheduledSync()).resolves.toBeUndefined();
    });
  });

  describe('reads', () => {
    it('summary refreshes first when the last sync is old, then returns counts per severity and kind', async () => {
      const { svc, ds } = build([
        [/count\(\*\)::int AS open/, [{ open: 5, unread: 3, errors: 1, warnings: 2, infos: 2 }]],
        [/GROUP BY n.kind/, [{ kind: 'NEGATIVE_RD', total: 1, unread: 1 }]],
      ]);
      const r = await svc.summary('clerk');
      expect(ds.transaction).toHaveBeenCalled();
      expect(r).toMatchObject({ open: 5, unread: 3, bySeverity: { error: 1, warning: 2, info: 2 }, byKind: { NEGATIVE_RD: { total: 1, unread: 1 } } });
    });

    it('summary binds the username (read state is per user)', async () => {
      const { svc, calls } = build([[/count\(\*\)::int AS open/, [{ open: 0, unread: 0, errors: 0, warnings: 0, infos: 0 }]]]);
      await svc.summary("x'; DROP TABLE t;--");
      const q = calls.find((c) => /AS unread/.test(c.sql))!;
      expect(q.params[0]).toContain('DROP TABLE');
      expect(q.sql).not.toContain('DROP TABLE');
    });

    it('a failed refresh does not stop the screen from loading', async () => {
      const { svc, ds } = build([[/count\(\*\)::int AS open/, [{ open: 1, unread: 1, errors: 0, warnings: 1, infos: 0 }]]]);
      ds.transaction.mockRejectedValue(new Error('x'));
      expect((await svc.summary('u')).open).toBe(1);
    });

    describe('list', () => {
      const listWith = async (o: any) => {
        const b = build([[/SELECT count\(\*\)::int AS total/, [{ total: 0 }]]]);
        await b.svc.list('u', o);
        return b.calls.filter((c) => /FROM system_notifications n/.test(c.sql));
      };

      it('defaults to OPEN notifications and bounds the page size', async () => {
        const [count, rows] = await listWith({ limit: 100000, offset: -5 });
        expect(count.params).toEqual(['u', 'OPEN']);
        expect(rows.sql).toMatch(/LIMIT 200 OFFSET 0/);
      });
      it('status=all removes the status filter, resolved selects RESOLVED', async () => {
        expect((await listWith({ status: 'all' }))[0].params).toEqual(['u']);
        expect((await listWith({ status: 'resolved' }))[0].params).toEqual(['u', 'RESOLVED']);
      });
      it('filters are bound parameters, not pasted into the SQL', async () => {
        const [count] = await listWith({ kind: "A'; DROP", severity: 'error', search: ' 1001 ', unreadOnly: true });
        expect(count.sql).not.toContain('DROP');
        expect(count.params).toEqual(['u', 'OPEN', "A'; DROP", 'error', '%1001%']);
        expect(count.sql).toMatch(/r\.notification_id IS NULL/);
      });
      it('a non-numeric limit or offset falls back to the defaults', async () => {
        const [, rows] = await listWith({ limit: 'abc' as any, offset: 'x' as any });
        expect(rows.sql).toMatch(/LIMIT 50 OFFSET 0/);
      });
      it('errors sort first, then warnings, then info', async () => {
        const [, rows] = await listWith({});
        expect(rows.sql).toMatch(/CASE n\.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END/);
      });
      it('rows are returned in camelCase', async () => {
        const b = build([
          [/SELECT count\(\*\)::int AS total/, [{ total: 1 }]],
          [/SELECT n\.id/, [{ id: 1, kind: 'K', severity: 'info', title: 't', body: 'b', mbno: '9', member_name: 'M', action_path: '/p', action_label: 'L', status: 'OPEN', created_at: 'c', updated_at: 'u', resolved_at: null, read: false }]],
        ]);
        const r = await b.svc.list('u', {});
        expect(r.rows[0]).toMatchObject({ memberNo: '9', memberName: 'M', actionPath: '/p', actionLabel: 'L', read: false });
      });
    });

    describe('read state', () => {
      it('markRead on an unknown notification is a 404', async () => {
        await expect(build().svc.markRead(99, 'u')).rejects.toBeInstanceOf(NotFoundException);
      });
      it('markRead is idempotent (ON CONFLICT DO NOTHING)', async () => {
        const { svc, calls } = build([[/SELECT 1 FROM system_notifications/, [{ '?column?': 1 }]]]);
        expect(await svc.markRead(1, 'u')).toEqual({ id: 1, read: true });
        expect(calls.find((c) => /INSERT INTO system_notification_reads/.test(c.sql))!.sql).toMatch(/ON CONFLICT DO NOTHING/);
      });
      it('markUnread only deletes that user\'s mark', async () => {
        const { svc, calls } = build();
        await svc.markUnread(4, 'clerk');
        expect(calls[0].params).toEqual([4, 'clerk']);
      });
      it('markAllRead can be limited to one kind and reports how many it marked', async () => {
        const { svc, calls } = build([[/INSERT INTO system_notification_reads/, [{ notification_id: 1 }, { notification_id: 2 }]]]);
        expect(await svc.markAllRead('u', 'NEGATIVE_RD')).toEqual({ marked: 2 });
        expect(calls[0].params).toEqual(['u', 'NEGATIVE_RD']);
        await svc.markAllRead('u');
        expect(calls[1].params).toEqual(['u', null]);
      });
    });
  });
});
