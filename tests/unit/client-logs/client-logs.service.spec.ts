import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClientLogsService } from '../../../src/modules/client-logs/client-logs.service';

describe('client-logs/ClientLogsService', () => {
  let dir: string; let record: jest.Mock; let svc: ClientLogsService;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clientlogs-'));
    record = jest.fn().mockResolvedValue(undefined);
    svc = new ClientLogsService({ get: (_k: string, d: string) => dir || d } as any, { record } as any);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (h: string) => fs.readFileSync(path.join(dir, 'clients', `${h}.log`), 'utf8');
  const e = (o: any = {}) => ({ level: 'info', route: '/x', message: 'hi', timestamp: '2026-01-01T00:00:00Z', ...o });

  it('creates the clients directory', () => expect(fs.existsSync(path.join(dir, 'clients'))).toBe(true));
  it('writes one line per entry', async () => {
    await svc.writeClientLogs('PC1', [e(), e({ message: 'two' })]);
    expect(file('PC1').trim().split('\n')).toHaveLength(2);
  });
  it('line format is [timestamp] [level] [route] message', async () => {
    await svc.writeClientLogs('PC1', [e()]);
    expect(file('PC1')).toContain('[2026-01-01T00:00:00Z] [info] [/x] hi');
  });
  it('sanitises a path-traversal hostname', async () => {
    await svc.writeClientLogs('../../evil', [e()]);
    expect(fs.existsSync(path.join(dir, 'clients', '.._.._evil.log'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '..', 'evil.log'))).toBe(false);
  });
  it('sanitises slashes and spaces in the hostname', async () => {
    await svc.writeClientLogs('a b/c', [e()]);
    expect(fs.existsSync(path.join(dir, 'clients', 'a_b_c.log'))).toBe(true);
  });
  it('redacts a password inside the entry data', async () => {
    await svc.writeClientLogs('PC1', [e({ data: { password: 'Secret@1', user: 'bob' } })]);
    expect(file('PC1')).not.toContain('Secret@1'); expect(file('PC1')).toContain('bob');
  });
  it('redacts a Bearer token inside the message', async () => {
    await svc.writeClientLogs('PC1', [e({ message: 'Authorization: Bearer abc.def' })]);
    expect(file('PC1')).not.toContain('abc.def');
  });
  it('maps error and warn levels, everything else becomes info, in service_log', async () => {
    await svc.writeClientLogs('PC1', [e({ level: 'error' }), e({ level: 'warn' }), e({ level: 'debug' })]);
    expect(record.mock.calls.map((c) => c[0].level)).toEqual(['error', 'warn', 'info']);
  });
  it('stores the hostname in the service_log metadata', async () => {
    await svc.writeClientLogs('PC1', [e({ data: { a: 1 } })]);
    expect(record.mock.calls[0][0].metadata).toMatchObject({ hostname: 'PC1', a: 1 });
  });
  it('wraps primitive data under metadata.data', async () => {
    await svc.writeClientLogs('PC1', [e({ data: 'str' })]);
    expect(record.mock.calls[0][0].metadata.data).toBe('str');
  });
  it('handles an empty batch', async () => {
    await expect(svc.writeClientLogs('PC1', [])).resolves.toBeUndefined();
  });
  it('does not throw when the file cannot be written', async () => {
    fs.rmSync(path.join(dir, 'clients'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, 'clients'), 'now a file');
    await expect(svc.writeClientLogs('PC1', [e()])).resolves.toBeUndefined();
  });
});
