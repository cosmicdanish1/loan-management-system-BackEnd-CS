import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import * as compression from 'compression';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
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

  // Global interceptors
  app.useGlobalInterceptors(new TransformInterceptor());

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

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = configService.get('PORT', 3000);
  // BUG FIX: bind to 0.0.0.0 so NestJS listens on ALL network interfaces
  // (Ethernet, Wi-Fi, LAN adapter) — not just the loopback interface.
  // Without this, client PCs on the LAN cannot reach the backend even if
  // the firewall port is open.
  await app.listen(port, '0.0.0.0');

  logger.log(`🚀 Application is running on: http://0.0.0.0:${port} (all interfaces)`);
  logger.log(`📚 Swagger documentation: http://localhost:${port}/api/docs`);
}

bootstrap();
