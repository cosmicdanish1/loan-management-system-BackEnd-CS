import { JiraClientService } from '../../../src/modules/support/services/jira-client.service';

const cfg = () => ({ get: (k: string) => ({ JIRA_BASE_URL: 'https://x.atlassian.net', JIRA_EMAIL: 'a@b.com', JIRA_API_TOKEN: 'T', JIRA_PROJECT_KEY: 'SPT' } as any)[k] }) as any;

describe('Jira requests have timeouts (ES-433)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('creating an issue has a signal, also on the retry without Priority', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'priority is not on the screen' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ key: 'SPT-1' }) }) as any;
    await new JiraClientService(cfg()).createIssue({ summary: 's', description: 'd', priority: 'HIGH' });
    for (const call of (global.fetch as jest.Mock).mock.calls) expect(call[1].signal).toBeDefined();
  });
  it('uploading an attachment has a signal', async () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const f = path.join(os.tmpdir(), `shot-${Date.now()}.png`);
    fs.writeFileSync(f, 'x');
    global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as any;
    await new JiraClientService(cfg()).attachFile('SPT-1', f);
    fs.unlinkSync(f);
    expect((global.fetch as jest.Mock).mock.calls[0][1].signal).toBeDefined();
  });
  it('a request that never answers is cancelled by the signal instead of waiting for ever', async () => {
    // AbortSignal.timeout uses an internal timer that fake timers do not control: replace it with a signal that fires at once
    const asked: number[] = [];
    jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { asked.push(ms); const c = new AbortController(); setTimeout(() => c.abort(), 5); return c.signal; });
    global.fetch = jest.fn((_u: string, init: any) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => rej(new Error('aborted'))); })) as any;
    const err: Error = await new JiraClientService(cfg()).createIssue({ summary: 's', description: 'd', priority: 'LOW' }).catch((e) => e);
    jest.restoreAllMocks();
    expect(err.message).toBe('aborted');
    expect(asked).toEqual([15000]);
  });
});
