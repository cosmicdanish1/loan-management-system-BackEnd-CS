import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';
import { MobileThrottlerGuard } from '../../../src/modules/mobile/security/mobile-throttler.guard';

@Controller('mobile-test')
@UseGuards(MobileThrottlerGuard)
class MobileLikeController {
  @Get('ping') ping() { return { ok: true }; }
}

@Controller('staff-test')
class StaffLikeController {
  @Get('ping') ping() { return { ok: true }; }
}

async function makeApp(trustProxy: string | false): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 3 }])],
    controllers: [MobileLikeController, StaffLikeController],
    providers: [MobileThrottlerGuard],
  }).compile();
  const app = mod.createNestApplication();
  (app.getHttpAdapter().getInstance() as any).set('trust proxy', trustProxy);
  await app.init();
  return app;
}

jest.setTimeout(30000); // first Nest app compile on a cold run exceeds the 5 s default

describe('mobile rate limiting (ES-217) and real client IP (ES-218)', () => {
  let app: INestApplication;
  afterEach(async () => app?.close());

  it('limits mobile routes per client IP and answers 429 with Retry-After', async () => {
    app = await makeApp('loopback');
    for (let i = 0; i < 3; i++) await request(app.getHttpServer()).get('/mobile-test/ping').expect(200);
    const res = await request(app.getHttpServer()).get('/mobile-test/ping').expect(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('never limits routes that do not use the mobile guard (desktop staff routes)', async () => {
    app = await makeApp('loopback');
    for (let i = 0; i < 20; i++) await request(app.getHttpServer()).get('/staff-test/ping').expect(200);
  });

  it('counts each real client separately when the tunnel (loopback) forwards X-Forwarded-For', async () => {
    app = await makeApp('loopback');
    const hit = (ip: string) => request(app.getHttpServer()).get('/mobile-test/ping').set('X-Forwarded-For', ip);
    for (let i = 0; i < 3; i++) await hit('203.0.113.10').expect(200);
    await hit('203.0.113.10').expect(429); // attacker is limited ...
    await hit('203.0.113.77').expect(200); // ... another member is not
  });

  it('without trust proxy every request looks like one client (the problem ES-218 fixes)', async () => {
    app = await makeApp(false);
    const hit = (ip: string) => request(app.getHttpServer()).get('/mobile-test/ping').set('X-Forwarded-For', ip);
    for (let i = 0; i < 3; i++) await hit(`203.0.113.${i}`).expect(200);
    await hit('203.0.113.200').expect(429); // a fresh IP is blocked because the tracker is the tunnel's 127.0.0.1
  });
});
