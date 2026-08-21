import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { buildSwaggerConfig } from './config/swagger.config';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { HttpAccessLogInterceptor } from './common/interceptors/http-access-log.interceptor';
import { ServiceLogService } from './common/logging/service-log.service';
import { patchQueryResultLogging } from './common/logging/query-result-logger';
import * as compression from 'compression';

const bootstrapLogger = new Logger('Bootstrap');

process.on('unhandledRejection', (reason) => {
  bootstrapLogger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}`);
});

process.on('uncaughtException', (error) => {
  bootstrapLogger.error(`Uncaught Exception: ${error.stack || error.message}`);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // Install winston as the application logger so every Logger.* call flows through
  // the configured transports (rotation, redaction, per-domain routing) and picks
  // up the request correlation id. Without this, Nest's default console logger is
  // used and the winston file logging stays dormant.
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  app.use(compression());
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

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
  app.enableCors({
    origin: (_origin, callback) => callback(null, true),
    credentials: true,
  });

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global filters
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Global interceptors — HttpAccessLogInterceptor is DI-resolved (not `new`) so
  // it can be constructor-injected with ServiceLogService for DB-side API logging.
  app.useGlobalInterceptors(
    app.get(HttpAccessLogInterceptor),
    new TransformInterceptor(),
  );

  // Log every DB query's full result (not just the SQL) to the db-queries file
  // and the service_log table — TypeORM's own logger interface only sees the
  // query text before it runs, so this patches the query runner directly.
  await patchQueryResultLogging(app.get(DataSource), app.get(ServiceLogService));

  // Swagger documentation.
  //
  // Exposing this hands any LAN user a complete map of the API, so it is OFF in
  // production by default. For emergency direct-IP access (e.g. hitting the
  // server from Postman when the desktop client is unavailable) an operator can
  // set ENABLE_SWAGGER=true in the server .env, restart, use the docs, then turn
  // it back off. Outside production it is always on for local development.
  const isProduction = configService.get('NODE_ENV') === 'production';
  const swaggerForced =
    String(configService.get('ENABLE_SWAGGER', 'false')).toLowerCase() === 'true';
  const swaggerEnabled = !isProduction || swaggerForced;

  if (swaggerEnabled) {
    const document = SwaggerModule.createDocument(app, buildSwaggerConfig());
    SwaggerModule.setup('api/docs', app, document);
    if (isProduction && swaggerForced) {
      logger.warn(
        '⚠️  Swagger is ENABLED in production via ENABLE_SWAGGER=true — the full API map is exposed on the LAN. Disable it when the emergency task is done.',
      );
    }
  }

  const port = configService.get('PORT', 3000);
  // BUG FIX: bind to 0.0.0.0 so NestJS listens on ALL network interfaces
  // (Ethernet, Wi-Fi, LAN adapter) — not just the loopback interface.
  // Without this, client PCs on the LAN cannot reach the backend even if
  // the firewall port is open.
  await app.listen(port, '0.0.0.0');

  logger.log(`🚀 Application is running on: http://0.0.0.0:${port} (all interfaces)`);
  if (swaggerEnabled) {
    logger.log(`📚 Swagger documentation: http://localhost:${port}/api/docs`);
    logger.log(`📄 OpenAPI JSON:          http://localhost:${port}/api/docs-json`);
  }
}

bootstrap();
