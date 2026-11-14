import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * ES-268 / ES-296: global rate limit. Limits come from THROTTLE_LIMIT / THROTTLE_TTL (see AppModule); routes that need a
 * stricter limit (login, 2FA steps, client-logs) declare their own @Throttle(...). The key is the real client IP
 * (`trust proxy` in main.ts makes req.ip correct behind the tunnel).
 *
 * Skipped: /health (monitoring) and /mobile/* (those controllers use MobileThrottlerGuard with their own limits, and
 * counting them twice would halve the limit).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const path: string = req?.path || req?.url || '';
    return /\/health\/?$/.test(path) || /\/mobile(\/|$)/.test(path);
  }
}
