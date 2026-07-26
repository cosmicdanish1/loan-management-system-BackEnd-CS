import { DocumentBuilder } from '@nestjs/swagger';

/**
 * Single source of truth for the OpenAPI/Swagger document definition.
 *
 * Shared by:
 *  - main.ts            → serves live Swagger UI at /api/docs
 *  - scripts/generate-openapi.ts → writes openapi.json / Postman / markdown
 *
 * Keeping one builder here means the live docs and the exported artifacts can
 * never drift apart.
 */
export function buildSwaggerConfig() {
  return new DocumentBuilder()
    .setTitle('Paper White Technology - LMS API')
    .setDescription(
      'Comprehensive API for the Paper White Technology Loan Management System. ' +
        'Use the Authorize button (JWT-auth) with a Bearer token obtained from POST /auth/login.',
    )
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
}
