import { of, lastValueFrom } from 'rxjs';
import { MemberCacheInterceptor, ResponseCache, etagOf } from '../../../src/modules/mobile/data/response-cache.interceptor';

const cfg = (ttl: number): any => ({ get: (_k: string, d: any) => (_k === 'MOBILE_CACHE_TTL_SECONDS' ? ttl : d) });

function run(i: MemberCacheInterceptor, opts: { mbno?: string | null; url?: string; method?: string; inm?: string; data: any; calls?: { n: number } }) {
  const headers: Record<string, string> = {};
  const res: any = { statusCode: 200, setHeader: (k: string, v: string) => (headers[k] = v), status(c: number) { res.statusCode = c; return res; } };
  const req: any = { method: opts.method ?? 'GET', originalUrl: opts.url ?? '/api/v1/mobile/home', user: opts.mbno === null ? undefined : { mbno: opts.mbno ?? '5' }, headers: opts.inm ? { 'if-none-match': opts.inm } : {} };
  const ctx: any = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
  const next: any = { handle: () => { if (opts.calls) opts.calls.n++; return of(opts.data); } };
  return lastValueFrom(i.intercept(ctx, next)).then((body) => ({ body, headers, status: res.statusCode }));
}

describe('mobile response cache and ETag (ES-227)', () => {
  it('answers from memory the second time for the same member and address, with an ETag', async () => {
    const i = new MemberCacheInterceptor(cfg(45)); const calls = { n: 0 };
    const a = await run(i, { data: { x: 1 }, calls }); const b = await run(i, { data: { x: 999 }, calls });
    expect(calls.n).toBe(1); expect(a.headers['X-Cache']).toBe('MISS'); expect(b.headers['X-Cache']).toBe('HIT');
    expect(b.body).toEqual({ x: 1 }); expect(b.headers.ETag).toBe(a.headers.ETag);
    expect(a.headers['Cache-Control']).toContain('private');
  });
  it('never shares an answer between two members or two addresses', async () => {
    const i = new MemberCacheInterceptor(cfg(45)); const calls = { n: 0 };
    await run(i, { mbno: '5', data: { v: 'five' }, calls });
    const other = await run(i, { mbno: '6', data: { v: 'six' }, calls });
    const url = await run(i, { mbno: '5', url: '/api/v1/mobile/loans', data: { v: 'loans' }, calls });
    expect(other.body).toEqual({ v: 'six' }); expect(url.body).toEqual({ v: 'loans' }); expect(calls.n).toBe(3);
  });
  it('a matching If-None-Match gets 304 and no body, on a cache hit and on a fresh answer', async () => {
    const i = new MemberCacheInterceptor(cfg(45)); const tag = etagOf({ x: 1 });
    const fresh = await run(i, { data: { x: 1 }, inm: tag }); expect(fresh.status).toBe(304); expect(fresh.body).toBeUndefined();
    const hit = await run(i, { data: { x: 1 }, inm: tag }); expect(hit.status).toBe(304);
    const changed = await run(i, { url: '/api/v1/mobile/other', data: { x: 2 }, inm: tag }); expect(changed.status).toBe(200); expect(changed.body).toEqual({ x: 2 });
  });
  it('TTL 0 switches the cache off but still sends the ETag', async () => {
    const i = new MemberCacheInterceptor(cfg(0)); const calls = { n: 0 };
    const a = await run(i, { data: { x: 1 }, calls }); await run(i, { data: { x: 1 }, calls });
    expect(calls.n).toBe(2); expect(a.headers.ETag).toBeTruthy();
  });
  it('does nothing for a request without a signed-in member or for a non-GET', async () => {
    const i = new MemberCacheInterceptor(cfg(45)); const calls = { n: 0 };
    const anon = await run(i, { mbno: null, data: { x: 1 }, calls }); const post = await run(i, { method: 'POST', data: { x: 1 }, calls });
    expect(anon.headers.ETag).toBeUndefined(); expect(post.headers.ETag).toBeUndefined(); expect(calls.n).toBe(2);
  });
  it('the cache expires entries and drops the oldest when full', () => {
    let t = 1000; const c = new ResponseCache(2, () => t);
    c.set('a', 1, 'ea', 100); c.set('b', 2, 'eb', 100); c.set('c', 3, 'ec', 100);
    expect(c.get('a')).toBeUndefined(); expect(c.get('b')?.data).toBe(2); expect(c.size()).toBe(2);
    t = 1200; expect(c.get('b')).toBeUndefined(); expect(c.size()).toBe(1); // b was removed when found expired; c stays until it is asked for
  });
  it('the ETag depends on the data only', () => {
    expect(etagOf({ a: 1 })).toBe(etagOf({ a: 1 })); expect(etagOf({ a: 1 })).not.toBe(etagOf({ a: 2 })); expect(etagOf(undefined)).toBe(etagOf(null));
  });
});
