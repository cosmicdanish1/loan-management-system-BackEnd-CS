import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { buildValidationException } from './common/validation/friendly-validation';
import { createHeavyReportGate } from './common/concurrency/single-flight';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import * as compression from 'compression';
import { json, urlencoded } from 'express';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DataSource } from 'typeorm';
import { HttpAccessLogInterceptor } from './common/interceptors/http-access-log.interceptor';
import { ServiceLogService } from './common/logging/service-log.service';
import { patchQueryResultLogging } from './common/logging/query-result-logger';

async function bootstrap() {
  // The default body-parser limit is 100 KB: a desktop client's batched log upload (/client-logs) is
  // routinely larger and was rejected with "PayloadTooLargeError" (ES-44/ES-71), so those logs were lost.
  // Parsers are registered explicitly with a higher limit instead of Nest's built-in defaults.
  const app = await NestFactory.create(AppModule, { bodyParser: false, bufferLogs: true });
  // Winston is the application logger: every Nest Logger.* call goes through the rotating, redacting, request-id
  // stamped file transports from createWinstonConfig. Without this the files stay empty (logs stopped 2026-09-05).
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ extended: true, limit: '5mb' }));
  app.use(compression());
  app.use(createHeavyReportGate()); // ES-267: heavy reports share a few slots so they cannot use up the database pool
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // ES-218: behind the Cloudflare Tunnel every request reaches this process from 127.0.0.1 (cloudflared), so without this
  // req.ip would be 127.0.0.1 for every member and one attacker would rate-limit everybody. 'loopback' trusts the
  // X-Forwarded-For header ONLY when the connection comes from this PC itself; desktop clients on the LAN connect
  // directly and keep their own IP (they cannot spoof it). Override with TRUST_PROXY in .env if needed.
  const trustProxy = String(configService.get('TRUST_PROXY', 'loopback'));
  (app.getHttpAdapter().getInstance() as any).set('trust proxy', trustProxy === 'false' ? false : trustProxy);

  // Refuse to start in production with default/insecure secrets
  if (configService.get('NODE_ENV') === 'production') {
    const jwtSecret = configService.get<string>('JWT_SECRET', '');
    if (!jwtSecret || jwtSecret.includes('change-this') || jwtSecret.length < 32) {
      logger.error('FATAL: JWT_SECRET is missing, too short, or still set to the default value. Set a strong secret in .env before running in production.');
      process.exit(1);
    }
  }

  // Global configuration
  app.setGlobalPrefix(configService.get('API_PREFIX', 'api/v1'));

  // Enable CORS — allow any origin on the LAN.
  // BUG FIX: the old strict localhost whitelist blocked every client PC on the
  // LAN because their requests arrive from a different Origin (e.g. file://, or
  // a local Electron renderer that Chromium labels differently).
  // Electron apps do not send a meaningful Origin header, so whitelist-based
  // CORS is both ineffective and harmful here — allow all origins instead.
  // ES-295: the old reflect-everything rule let any website a user visits call the API with their credentials.
  // Allowed now: requests with no Origin (Electron, mobile app, curl), the "null"/file:// origin of a packaged
  // Electron renderer, localhost, private LAN addresses (10.x, 172.16-31.x, 192.168.x) and any origin listed in
  // CORS_ALLOWED_ORIGINS (comma separated, e.g. a Cloudflare Tunnel host). Everything else gets no CORS headers.
  const extraOrigins = String(configService.get('CORS_ALLOWED_ORIGINS', ''))
    .split(',').map((s) => s.trim()).filter(Boolean);
  const lanOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})(:\d+)?$/i;
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || origin === 'null' || origin.startsWith('file://') || lanOrigin.test(origin) || extraOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
  });

  // ES-295: basic security headers (helmet is not installed) and no framework banner.
  (app.getHttpAdapter().getInstance() as any).disable('x-powered-by');
  (app.getHttpAdapter().getInstance() as any).use((_req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Easter egg: credits for anyone inspecting traffic or visiting /humans.txt
  (app.getHttpAdapter().getInstance() as any).use((req: any, res: any, next: any) => {
    res.setHeader('X-Crafted-By', 'The Kova Studio');
    if (req.path === '/humans.txt') {
      res.type('text/plain').send(
        '/* TEAM */\nMD Danish Qureshi\nAkshay Kumar\n\n/* STUDIO */\nThe Kova Studio\n\n/* NOTE */\nOur first application to go into production, built with love.\n\n/* RIDDLE */\nOpen the glass window of the browser (F12) and read the art.\n',
      );
      return;
    }
    next();
  });

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      // plain-language problems per field with stable codes (ES-468 / ES-286)
      exceptionFactory: buildValidationException,
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global filters
  app.useGlobalFilters(new GlobalExceptionFilter(app.get(ServiceLogService)));

  // Global interceptors
  // HttpAccessLogInterceptor is DI-resolved so it can use ServiceLogService (one http-access line + one service_log row per call).
  app.useGlobalInterceptors(app.get(HttpAccessLogInterceptor), new TransformInterceptor());

  // Log every DB query's full result (db-queries file + service_log), not just the SQL text.
  await patchQueryResultLogging(app.get(DataSource), app.get(ServiceLogService));

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('Paper White Technology - LMS API')
    .setDescription('Comprehensive API for Paper White Technology Loan Management System')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .build();

  // ES-295: the API documentation maps every route, so it is served only when SWAGGER_ENABLED=true (off by default).
  const swaggerOn = String(configService.get('SWAGGER_ENABLED', 'false')).toLowerCase() === 'true';
  if (swaggerOn) {
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = configService.get('PORT', 3000);
  // BUG FIX: bind to 0.0.0.0 so NestJS listens on ALL network interfaces
  // (Ethernet, Wi-Fi, LAN adapter) — not just the loopback interface.
  // Without this, client PCs on the LAN cannot reach the backend even if
  // the firewall port is open.
  await app.listen(port, '0.0.0.0');

  logger.log(`🚀 Application is running on: http://0.0.0.0:${port} (all interfaces)`);
  if (swaggerOn) logger.log(`📚 Swagger documentation: http://localhost:${port}/api/docs`);
}

bootstrap();
