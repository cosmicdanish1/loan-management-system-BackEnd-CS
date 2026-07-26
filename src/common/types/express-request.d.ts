import 'express';

/**
 * Augments Express's Request with the correlation id that the nestjs-cls
 * middleware sets (see ClsModule setup in app.module.ts). Consumed by the
 * HTTP access-log interceptor and the global exception filter.
 */
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}
