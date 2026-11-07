import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdmissionService, ServerBusyError } from './admission.service';

/** Staff routes that are background chatter from the desktop app and must not hold mobile back. */
const STAFF_IGNORED = [/\/health$/, /\/auth\/heartbeat$/, /\/client-logs/, /\/analytics\//, /^\/api\/docs/];
/** Tiny public mobile routes that must answer even when the server is busy (the app calls them first). */
const MOBILE_EXEMPT = [/\/mobile\/status$/, /\/mobile\/config$/];

/**
 * Applied to EVERY request (see MobileModule.configure). Counts staff requests, and makes mobile requests wait their
 * turn behind them (first in, first out). ES-386.
 */
@Injectable()
export class PriorityMiddleware implements NestMiddleware {
  private readonly mobilePrefix: string;

  constructor(
    private readonly admission: AdmissionService,
    config: ConfigService,
  ) {
    const prefix = String(config.get('API_PREFIX', 'api/v1')).replace(/^\/+|\/+$/g, '');
    this.mobilePrefix = `/${prefix}/mobile`;
  }

  async use(req: any, res: any, next: (err?: unknown) => void): Promise<void> {
    const path = String(req.originalUrl || req.url || '').split('?')[0];

    if (path === this.mobilePrefix || path.startsWith(this.mobilePrefix + '/')) {
      if (req.method === 'OPTIONS' || MOBILE_EXEMPT.some((r) => r.test(path))) return next();
      try {
        const slot = await this.admission.admitMobile();
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            slot.release();
          }
        };
        res.once('finish', release);
        res.once('close', release);
        if (slot.waitedMs > 0) res.setHeader('X-Queue-Wait-Ms', String(slot.waitedMs));
        return next();
      } catch (e) {
        if (e instanceof ServerBusyError) {
          res.status(503).set('Retry-After', String(e.retryAfterSeconds)).json({
            statusCode: 503,
            error: 'Service Unavailable',
            code: 'SERVER_BUSY',
            message: 'The society server is busy with staff work. Please wait a moment.',
            queuePosition: e.queuePosition,
            retryAfterSeconds: e.retryAfterSeconds,
            timestamp: new Date().toISOString(),
            path: req.originalUrl,
            method: req.method,
          });
          return;
        }
        return next(e);
      }
    }

    if (req.method !== 'OPTIONS' && !STAFF_IGNORED.some((r) => r.test(path))) {
      const done = this.admission.staffStart();
      res.once('finish', done);
      res.once('close', done);
    }
    next();
  }
}
