import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SupportQueryService, Reporter } from '../../../src/modules/support/services/support-query.service';
import { JiraClientService } from '../../../src/modules/support/services/jira-client.service';
import { CreateSupportQueryDto } from '../../../src/modules/support/dto/create-support-query.dto';

const cfg = (o: Record<string, string> = {}) => ({ get: (k: string, d?: any) => o[k] ?? d }) as any;
const JIRA = { JIRA_BASE_URL: 'https://x.atlassian.net/', JIRA_EMAIL: 'a@b.com', JIRA_API_TOKEN: 'SECRETTOKEN', JIRA_PROJECT_KEY: 'SPT' };

function row(over: any = {}) {
  return {
    id: 1, subject: 'Subject', description: 'A long enough description', module: null, queryType: 'BUG', priority: 'HIGH',
    reporterUsername: 'clerk', reporterRole: 'clerk', route: '/x', appVersion: '1.9.0', clientInfo: 'win',
    jiraStatus: 'PENDING', jiraAttempts: 0, jiraKey: null, telegramStatus: 'PENDING', telegramAttempts: 0, screenshotPath: null,
    createdAt: new Date(), ...over,
  };
}

function build(opts: { rows?: any[]; jiraOk?: boolean; jiraConfigured?: boolean; jiraFlag?: boolean; tgConfigured?: boolean; tgMuted?: boolean } = {}) {
  const store = new Map<number, any>((opts.rows ?? [row()]).map((r) => [r.id, r]));
  const repo: any = {
    create: jest.fn((x: any) => ({ id: 1, createdAt: new Date(), ...x })),
    save: jest.fn(async (x: any) => { store.set(x.id, { ...row(), ...x }); return store.get(x.id); }),
    findOne: jest.fn(async ({ where }: any) => (store.has(where.id) ? { ...store.get(where.id) } : null)),
    findOneOrFail: jest.fn(async ({ where }: any) => ({ ...store.get(where.id) })),
    find: jest.fn(async () => []),
    update: jest.fn(async (id: number, patch: any) => { store.set(id, { ...store.get(id), ...patch }); }),
  };
  const jira: any = {
    isConfigured: () => opts.jiraConfigured ?? true,
    createIssue: jest.fn(async () => { if (opts.jiraOk === false) throw new Error('Jira 500'); return 'SPT-1'; }),
    attachFile: jest.fn(async () => undefined),
    browseUrl: (k: string) => `https://x/browse/${k}`,
  };
  const telegram: any = { isConfigured: () => opts.tgConfigured ?? true, send: jest.fn(async () => undefined) };
  const settings: any = { flag: () => opts.jiraFlag ?? true, isEnabled: () => !opts.tgMuted };
  const alerts: any = { send: jest.fn() };
  const svc = new SupportQueryService(repo, jira, telegram, settings, alerts);
  return { svc, repo, jira, telegram, alerts, store };
}
const admin: Reporter = { userId: '1', username: 'boss', role: 'admin', isAdmin: true };
const clerk: Reporter = { userId: '2', username: 'clerk', role: 'clerk', isAdmin: false };

describe('SupportQueryService', () => {
  describe('create', () => {
    it('saves the trimmed query with defaults and starts delivery in the background', async () => {
      const { svc, repo } = build({ rows: [] });
      const spy = jest.spyOn(svc as any, 'deliver').mockResolvedValue(undefined);
      await svc.create({ subject: '  Hello world  ', description: '  details here ok  ' } as any, clerk);
      const arg = repo.create.mock.calls[0][0];
      expect(arg).toMatchObject({ subject: 'Hello world', description: 'details here ok', queryType: 'OTHER', priority: 'MEDIUM', reporterUsername: 'clerk' });
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('access', () => {
    it('a user can open their own query, not someone else\'s', async () => {
      const { svc } = build();
      expect((await svc.getOne(1, clerk)).id).toBe(1);
      await expect(svc.getOne(1, { ...clerk, username: 'other' })).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('an administrator can open any query', async () => {
      expect((await build().svc.getOne(1, admin)).id).toBe(1);
    });
    it('an unknown query is a 404', async () => {
      await expect(build().svc.getOne(9, admin)).rejects.toBeInstanceOf(NotFoundException);
      await expect(build().svc.retry(9)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('listMine filters by the user name and caps at 100', async () => {
      const { svc, repo } = build();
      await svc.listMine('clerk');
      expect(repo.find).toHaveBeenCalledWith(expect.objectContaining({ where: { reporterUsername: 'clerk' }, take: 100 }));
    });
  });

  describe('delivery to Jira', () => {
    it('creates the issue once, stores the key and marks it SENT', async () => {
      const { svc, jira, store } = build();
      await (svc as any).deliver(1);
      expect(jira.createIssue).toHaveBeenCalledTimes(1);
      expect(jira.createIssue.mock.calls[0][0].summary).toBe('[Query #1] [Bug] Subject');
      expect(store.get(1)).toMatchObject({ jiraKey: 'SPT-1', jiraStatus: 'SENT' });
    });
    it('does not create a second issue when the key already exists (a retry after an attachment failure)', async () => {
      const { svc, jira } = build({ rows: [row({ jiraKey: 'SPT-9', screenshotPath: 'a.png' })] });
      jira.attachFile.mockRejectedValue(new Error('x'));
      await (svc as any).deliver(1);
      expect(jira.createIssue).not.toHaveBeenCalled();
    });
    it('a screenshot that fails to attach does not fail the query', async () => {
      const { svc, jira, store } = build({ rows: [row({ screenshotPath: 'a.png' })] });
      jira.attachFile.mockRejectedValue(new Error('too big'));
      await (svc as any).deliver(1);
      expect(store.get(1).jiraStatus).toBe('SENT');
    });
    it('a Jira error is stored and the attempt count goes up', async () => {
      const { svc, store } = build({ jiraOk: false });
      await (svc as any).deliver(1);
      expect(store.get(1)).toMatchObject({ jiraStatus: 'FAILED', jiraAttempts: 1, jiraError: 'Jira 500' });
    });
    it('after 5 failed attempts it stops trying', async () => {
      const { svc, jira } = build({ rows: [row({ jiraAttempts: 5, jiraStatus: 'FAILED' })] });
      await (svc as any).deliver(1);
      expect(jira.createIssue).not.toHaveBeenCalled();
    });
    it('Jira not configured: marked DISABLED, nothing called', async () => {
      const { svc, jira, store } = build({ jiraConfigured: false });
      await (svc as any).deliver(1);
      expect(jira.createIssue).not.toHaveBeenCalled();
      expect(store.get(1).jiraStatus).toBe('DISABLED');
    });
    it('ticket creation switched off in Settings: SKIPPED for good', async () => {
      const { svc, jira, store } = build({ jiraFlag: false });
      await (svc as any).deliver(1);
      expect(jira.createIssue).not.toHaveBeenCalled();
      expect(store.get(1).jiraStatus).toBe('SKIPPED');
    });
    it('labels carry the type and the module (spaces turned into dashes)', async () => {
      const { svc, jira } = build({ rows: [row({ queryType: 'DATA_CORRECTION', module: 'Loan Repayment' })] });
      await (svc as any).deliver(1);
      expect(jira.createIssue.mock.calls[0][0].labels).toEqual(['support-query', 'type-data-correction', 'Loan-Repayment']);
    });
    it('the same query is never delivered twice at the same time', async () => {
      const { svc, jira } = build();
      await Promise.all([(svc as any).deliver(1), (svc as any).deliver(1)]);
      expect(jira.createIssue).toHaveBeenCalledTimes(1);
    });
  });

  describe('delivery to Telegram / Discord', () => {
    it('sends once with the Jira link and marks SENT', async () => {
      const { svc, telegram, store } = build();
      await (svc as any).deliver(1);
      expect(telegram.send.mock.calls[0][0]).toContain('SPT-1');
      expect(telegram.send.mock.calls[0][0]).toContain('https://x/browse/SPT-1');
      expect(store.get(1).telegramStatus).toBe('SENT');
    });
    it('muted in Settings: SKIPPED, not sent', async () => {
      const { svc, telegram, store } = build({ tgMuted: true });
      await (svc as any).deliver(1);
      expect(telegram.send).not.toHaveBeenCalled();
      expect(store.get(1).telegramStatus).toBe('SKIPPED');
    });
    it('Telegram failure is stored with the attempt count and does not touch Jira\'s result', async () => {
      const { svc, telegram, store } = build();
      telegram.send.mockRejectedValue(new Error('429'));
      await (svc as any).deliver(1);
      expect(store.get(1)).toMatchObject({ telegramStatus: 'FAILED', telegramAttempts: 1, jiraStatus: 'SENT' });
    });
    it('the Discord card is sent only for new queries and only once', async () => {
      const { svc, alerts } = build();
      await (svc as any).deliver(1);
      await (svc as any).deliver(1);
      expect(alerts.send).toHaveBeenCalledTimes(1);
      expect(alerts.send.mock.calls[0][0]).toBe('query.new');
    });
    it('an old query being retried after a restart is not announced again', async () => {
      const { svc, alerts } = build({ rows: [row({ createdAt: new Date(Date.now() - 3600_000) })] });
      await (svc as any).deliver(1);
      expect(alerts.send).not.toHaveBeenCalled();
    });
    it('user text in the Discord card is escaped', async () => {
      const { svc, alerts } = build({ rows: [row({ subject: '<b>x</b>', reporterUsername: 'a&b' })] });
      await (svc as any).deliver(1);
      expect(alerts.send.mock.calls[0][2]).toContain('&lt;b&gt;x&lt;/b&gt;');
      expect(alerts.send.mock.calls[0][2]).toContain('a&amp;b');
    });
    it('a long description is cut in the Discord and Telegram messages', async () => {
      const { svc, alerts, telegram } = build({ rows: [row({ description: 'd'.repeat(5000) })] });
      await (svc as any).deliver(1);
      expect(alerts.send.mock.calls[0][2].length).toBeLessThan(900);
      expect(telegram.send.mock.calls[0][0].length).toBeLessThan(900);
    });
  });

  describe('retry', () => {
    it('admin retry resets the counters of the channels that have not been SENT, then delivers', async () => {
      const { svc, repo, store } = build({ rows: [row({ jiraStatus: 'FAILED', jiraAttempts: 5, telegramStatus: 'SENT', telegramAttempts: 1 })] });
      await svc.retry(1);
      expect(repo.update).toHaveBeenCalledWith(1, { jiraStatus: 'PENDING', jiraAttempts: 0 });
      expect(repo.update).not.toHaveBeenCalledWith(1, expect.objectContaining({ telegramStatus: 'PENDING' }));
      expect(store.get(1).jiraStatus).toBe('SENT');
    });
    it('retryPending asks only for rows under the attempt limit, oldest first, at most 20', async () => {
      const { svc, repo } = build();
      await svc.retryPending();
      const arg = repo.find.mock.calls[0][0];
      expect(arg.take).toBe(20);
      expect(arg.order).toEqual({ id: 'ASC' });
      expect(arg.where).toHaveLength(2);
    });
  });
});

describe('JiraClientService', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const jira = (o = JIRA) => new JiraClientService(cfg(o));

  it('needs URL, e-mail, token and project key', () => {
    expect(jira().isConfigured()).toBe(true);
    for (const k of Object.keys(JIRA)) expect(jira({ ...JIRA, [k]: '' }).isConfigured()).toBe(false);
  });
  it('describe never exposes the token or the e-mail', () => {
    const d = JSON.stringify(jira().describe());
    expect(d).not.toContain('SECRETTOKEN');
    expect(d).not.toContain('a@b.com');
    expect(jira().describe().site).toBe('x.atlassian.net');
  });
  it('browseUrl has no double slash even when the base URL ends with /', () => {
    expect(jira().browseUrl('SPT-5')).toBe('https://x.atlassian.net/browse/SPT-5');
  });
  it('createIssue sends the project, type, a 250 character summary and ADF paragraphs', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ key: 'SPT-7' }) })) as any;
    const key = await jira().createIssue({ summary: 's'.repeat(400), description: 'a\n\nb', priority: 'CRITICAL' });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(key).toBe('SPT-7');
    expect(body.fields.summary).toHaveLength(250);
    expect(body.fields.priority.name).toBe('Highest');
    expect(body.fields.description.content).toHaveLength(3);
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers.Authorization).toMatch(/^Basic /);
  });
  it('retries once without Priority when the project does not have it on the create screen', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Field priority cannot be set' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ key: 'SPT-8' }) }) as any;
    expect(await jira().createIssue({ summary: 's', description: 'd', priority: 'LOW' })).toBe('SPT-8');
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body).fields.priority).toBeUndefined();
  });
  it('any other Jira error is thrown with the status and a cut message', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 401, text: async () => 'x'.repeat(900) })) as any;
    const err: Error = await jira().createIssue({ summary: 's', description: 'd', priority: 'LOW' }).catch((e) => e);
    expect(err.message.startsWith('Jira 401')).toBe(true);
    expect(err.message.length).toBeLessThan(600);
  });
  it('requests to Jira have a timeout, so a hung Jira cannot block delivery forever', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ key: 'K' }) })) as any;
    await jira().createIssue({ summary: 's', description: 'd', priority: 'LOW' });
    expect((global.fetch as jest.Mock).mock.calls[0][1].signal).toBeDefined();
  });
  it('testConnection distinguishes a bad token from a missing project', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as any;
    expect((await jira().testConnection()).message).toMatch(/rejected the e-mail or API token/);
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ displayName: 'Dan' }) })
      .mockResolvedValueOnce({ ok: false, status: 404 }) as any;
    expect((await jira().testConnection()).message).toMatch(/project "SPT" was not found/);
  });
  it('testConnection without configuration does not call the network', async () => {
    global.fetch = jest.fn() as any;
    expect((await jira({} as any).testConnection()).ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('CreateSupportQueryDto', () => {
  const check = async (o: any) => (await validate(plainToInstance(CreateSupportQueryDto, o))).map((e) => e.property);
  const ok = { subject: 'Hello there', description: 'Description long enough' };
  it('accepts the minimum', async () => expect(await check(ok)).toEqual([]));
  it('rejects a short subject/description and an unknown type or priority', async () => {
    expect(await check({ ...ok, subject: 'abc' })).toContain('subject');
    expect(await check({ ...ok, description: 'short' })).toContain('description');
    expect(await check({ ...ok, queryType: 'HACK' })).toContain('queryType');
    expect(await check({ ...ok, priority: 'URGENT' })).toContain('priority');
  });
  it('rejects over-long fields', async () => {
    expect(await check({ ...ok, subject: 'x'.repeat(201) })).toContain('subject');
    expect(await check({ ...ok, description: 'x'.repeat(5001) })).toContain('description');
    expect(await check({ ...ok, clientInfo: 'x'.repeat(1001) })).toContain('clientInfo');
  });
});
