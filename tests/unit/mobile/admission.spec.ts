import { ConfigService } from '@nestjs/config';
import { AdmissionService, ServerBusyError } from '../../../src/modules/mobile/queue/admission.service';
import { PriorityMiddleware } from '../../../src/modules/mobile/queue/priority.middleware';

jest.useFakeTimers();

const config = (v: Record<string, string> = {}) => ({ get: (k: string, d?: unknown) => (k in v ? v[k] : d) }) as unknown as ConfigService;

/** Fake clock that moves together with jest's fake timers. */
function make(v: Record<string, string> = {}) {
  let t = 1_000_000;
  const svc = new AdmissionService(config(v));
  svc.now = () => t;
  const advance = (ms: number) => {
    t += ms;
    jest.advanceTimersByTime(ms);
  };
  return { svc, advance };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

afterEach(() => jest.clearAllTimers());

describe('AdmissionService: staff first, members last', () => {
  it('lets a mobile request run at once when nobody is working', async () => {
    const { svc, advance } = make();
    advance(1000); // past the staff grace period of a fresh start
    const slot = await svc.admitMobile();
    expect(slot.waitedMs).toBe(0);
    expect(svc.stats().mobileRunning).toBe(1);
    slot.release();
    expect(svc.stats().mobileRunning).toBe(0);
    svc.onModuleDestroy();
  });

  it('makes mobile wait while a staff request is running and releases it after the grace period', async () => {
    const { svc, advance } = make();
    advance(1000);
    const staffDone = svc.staffStart();
    let admitted = false;
    const p = svc.admitMobile().then((s) => { admitted = true; return s; });
    advance(500);
    await flush();
    expect(admitted).toBe(false);
    expect(svc.stats().queueLength).toBe(1);

    staffDone();
    advance(100); // inside the 300 ms grace
    await flush();
    expect(admitted).toBe(false);
    advance(300);
    await flush();
    expect(admitted).toBe(true);
    (await p).release();
    svc.onModuleDestroy();
  });

  it('serves waiting mobile requests first in, first out and never more than the limit at a time', async () => {
    const { svc, advance } = make({ MOBILE_QUEUE_MAX_CONCURRENT: '2' });
    advance(1000);
    const staffDone = svc.staffStart();
    const order: number[] = [];
    const slots: Array<{ release: () => void }> = [];
    [1, 2, 3, 4].forEach((n) => svc.admitMobile().then((s) => { order.push(n); slots.push(s); }));
    staffDone();
    advance(400);
    await flush();
    expect(order).toEqual([1, 2]); // only 2 at once
    slots[0].release();
    advance(30);
    await flush();
    expect(order).toEqual([1, 2, 3]);
    slots[1].release();
    advance(30);
    await flush();
    expect(order).toEqual([1, 2, 3, 4]);
    svc.onModuleDestroy();
  });

  it('answers SERVER_BUSY with the place in line after the maximum wait', async () => {
    const { svc, advance } = make({ MOBILE_QUEUE_MAX_WAIT_MS: '5000', MOBILE_QUEUE_STAFF_CAP_MS: '60000' });
    advance(1000);
    svc.staffStart(); // staff keep working
    const p = svc.admitMobile();
    const p2 = svc.admitMobile();
    const caught = Promise.allSettled([p, p2]);
    advance(5100);
    const [a, b] = await caught;
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    const err = (a as PromiseRejectedResult).reason as ServerBusyError;
    expect(err).toBeInstanceOf(ServerBusyError);
    expect(err.queuePosition).toBeGreaterThanOrEqual(1);
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(svc.stats().rejected).toBe(2);
    svc.onModuleDestroy();
  });

  it('refuses at once when the waiting line is full', async () => {
    const { svc, advance } = make({ MOBILE_QUEUE_MAX_LENGTH: '2', MOBILE_QUEUE_STAFF_CAP_MS: '60000' });
    advance(1000);
    svc.staffStart();
    const waiting = [svc.admitMobile(), svc.admitMobile()];
    waiting.forEach((w) => w.catch(() => undefined));
    await expect(svc.admitMobile()).rejects.toBeInstanceOf(ServerBusyError);
    svc.onModuleDestroy();
  });

  it('does not let a stuck staff request starve members forever (staff cap)', async () => {
    const { svc, advance } = make({ MOBILE_QUEUE_STAFF_CAP_MS: '10000' });
    advance(1000);
    svc.staffStart(); // never finishes
    const p = svc.admitMobile();
    advance(10100); // longer than the cap
    await flush();
    const slot = await Promise.race([p, Promise.resolve(null)]);
    expect(slot).not.toBeNull();
    (slot as any).release();
    svc.onModuleDestroy();
  });

  it('can be switched off', async () => {
    const { svc } = make({ MOBILE_QUEUE_ENABLED: 'false' });
    svc.staffStart();
    const slot = await svc.admitMobile();
    expect(slot.waitedMs).toBe(0);
    svc.onModuleDestroy();
  });
});

describe('PriorityMiddleware', () => {
  const res = () => {
    const handlers: Record<string, () => void> = {};
    const r: any = {
      once: (e: string, f: () => void) => { handlers[e] = f; },
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      json: jest.fn(),
      finish: () => handlers.finish?.(),
    };
    return r;
  };
  const build = (admission: Partial<AdmissionService>) => new PriorityMiddleware(admission as AdmissionService, config());

  it('counts a staff request until it finishes', async () => {
    const done = jest.fn();
    const mw = build({ staffStart: jest.fn(() => done) });
    const r = res();
    const next = jest.fn();
    await mw.use({ method: 'GET', originalUrl: '/api/v1/loans/cases?x=1' }, r, next);
    expect(next).toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    r.finish();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it.each(['/api/v1/health', '/api/v1/auth/heartbeat', '/api/v1/client-logs/batch', '/api/v1/analytics/track'])('ignores background staff call %s', async (url) => {
    const staffStart = jest.fn();
    await build({ staffStart }).use({ method: 'POST', originalUrl: url }, res(), jest.fn());
    expect(staffStart).not.toHaveBeenCalled();
  });

  it('lets /mobile/status and /mobile/config through without queueing', async () => {
    const admitMobile = jest.fn();
    const next = jest.fn();
    await build({ admitMobile }).use({ method: 'GET', originalUrl: '/api/v1/mobile/status' }, res(), next);
    await build({ admitMobile }).use({ method: 'GET', originalUrl: '/api/v1/mobile/config?lang=hi' }, res(), next);
    expect(admitMobile).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('queues other mobile routes and releases the slot when the response ends', async () => {
    const release = jest.fn();
    const mw = build({ admitMobile: jest.fn().mockResolvedValue({ waitedMs: 120, release }) });
    const r = res();
    const next = jest.fn();
    await mw.use({ method: 'GET', originalUrl: '/api/v1/mobile/home' }, r, next);
    expect(next).toHaveBeenCalledWith();
    expect(r.setHeader).toHaveBeenCalledWith('X-Queue-Wait-Ms', '120');
    r.finish();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('answers 503 SERVER_BUSY with queue position and Retry-After', async () => {
    const mw = build({ admitMobile: jest.fn().mockRejectedValue(new ServerBusyError(7, 9)) });
    const r = res();
    const next = jest.fn();
    await mw.use({ method: 'GET', originalUrl: '/api/v1/mobile/loans', method2: 'x' } as any, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(503);
    expect(r.set).toHaveBeenCalledWith('Retry-After', '9');
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SERVER_BUSY', queuePosition: 7, retryAfterSeconds: 9 }));
  });
});
