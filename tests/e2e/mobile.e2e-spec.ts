/**
 * Boots ONLY the MobileModule in-process (no dev server, no port) against the dev database and checks the wiring that unit
 * tests cannot: dependency injection, the separate DB pool, @Public() stepping aside from the global STAFF guard,
 * /status and /config answers from the real mobile_* tables, and that member routes refuse staff tokens.
 * Read-only: it only runs SELECTs. Needs the migration create-mobile-tables.sql applied.
 *   npx jest --config tests/e2e/jest-e2e.json tests/e2e/mobile.e2e-spec.ts
 */
import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as path from 'path';
import * as request from 'supertest';
import { Public } from '../../src/modules/auth/decorators';
import { JwtAuthGuard } from '../../src/modules/auth/guards/jwt-auth.guard';
import { MemberJwtGuard } from '../../src/modules/mobile/auth/member-jwt.guard';
import { MemberTokenService } from '../../src/modules/mobile/auth/member-token.service';
import { MobileModule } from '../../src/modules/mobile/mobile.module';
// Global modules the real app gets from AppModule; the loan / ledger services used by MobileModule need them.
import { LoggingModule } from '../../src/common/logging/logging.module';
import { AlertsModule } from '../../src/modules/alerts/alerts.module';
import { ReportHeadOrderModule } from '../../src/modules/report-head-order/report-head-order.module';
import { SharedModule } from '../../src/modules/shared/shared.module';

// A stand-in for a future member-only route and a staff-only route.
@Public()
@UseGuards(MemberJwtGuard)
@Controller('mobile-probe')
class MemberProbeController {
  @Get('me') me() { return { ok: true }; }
}
@Controller('staff-probe')
class StaffProbeController {
  @Get('me') me() { return { ok: true }; }
}

describe('MobileModule wiring (e2e, read-only)', () => {
  let app: INestApplication;
  let memberTokens: MemberTokenService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: path.join(__dirname, '..', '..', '.env') }), LoggingModule, SharedModule, ReportHeadOrderModule, AlertsModule, MobileModule,
        // The real app always has a default TypeORM connection; Nest's shutdown hook looks for it, so the test registers an empty one.
        TypeOrmModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (c: ConfigService) => ({ type: 'postgres' as const, host: c.get<string>('DB_HOST', 'localhost'), port: Number(c.get('DB_PORT', 5432)), username: c.get<string>('DB_USERNAME'), password: c.get<string>('DB_PASSWORD'), database: c.get<string>('DB_DATABASE'), entities: [path.join(__dirname, '..', '..', 'src').split(path.sep).join('/') + '/**/*.entity.ts'], synchronize: false }),
        }),
      ],
      controllers: [MemberProbeController, StaffProbeController],
      // The same global guard the real app uses for staff routes (no 'jwt' strategy registered here: @Public must skip it).
      providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
    }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    memberTokens = mod.get(MemberTokenService);
  }, 60000);

  afterAll(async () => {
    // Close the pools ourselves; Nest's own shutdown hook cannot find a DataSource in this reduced test module (not an app problem:
    // the real app never enables shutdown hooks).
    for (const name of ['mobile', undefined]) {
      try { await app.get<DataSource>(getDataSourceToken(name as any)).destroy(); } catch { /* already closed */ }
    }
    try { await app.close(); } catch { /* see above */ }
  });

  it('GET /api/v1/mobile/status is public and reports office hours, maintenance and versions', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/mobile/status').expect(200);
    expect(res.body.timeZone).toBe('Asia/Kolkata');
    expect(res.body.office).toMatchObject({ open: expect.any(String), close: expect.any(String), isOpenNow: expect.any(Boolean) });
    expect(res.body.maintenance).toHaveProperty('enabled');
    expect(res.body.app).toHaveProperty('android');
  });

  it('GET /api/v1/mobile/config returns feature flags with FD switched off', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/mobile/config?lang=hi').expect(200);
    expect(res.body.flags.fd).toBe(false);
    expect(res.body.flags.loans).toBe(true);
    expect(res.body.language).toBe('hi');
    expect(res.body.documents).toHaveProperty('terms');
  });

  it('the global staff guard still protects non-public routes', async () => {
    // JwtAuthGuard has no strategy here, so a non-public route cannot be reached: it must not answer 200.
    const res = await request(app.getHttpServer()).get('/api/v1/staff-probe/me');
    expect(res.status).not.toBe(200);
  });

  it('a member-only route refuses no token, junk, a staff-signed token and a member token for a member without access', async () => {
    const get = (t?: string) => {
      const r = request(app.getHttpServer()).get('/api/v1/mobile-probe/me');
      return t ? r.set('Authorization', `Bearer ${t}`) : r;
    };
    await get().expect(401);
    await get('not-a-token').expect(401);
    const staffToken = await new JwtService({ secret: process.env.JWT_SECRET || 'x'.repeat(40) }).signAsync({ sub: 1, username: 'admin' });
    await get(staffToken).expect(401);
    // correct signature and claims, but there is no ACTIVE mobile_account / device for this member
    await get(await memberTokens.signAccess('900000000999', 987654)).expect(401);
  });

  it('applies the mobile rate limit headers on mobile routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/mobile/status').expect(200);
    expect(Object.keys(res.headers).some((h) => h.startsWith('x-ratelimit'))).toBe(true);
  });
});
