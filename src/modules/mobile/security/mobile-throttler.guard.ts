import { ExecutionContext, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { InjectThrottlerOptions, InjectThrottlerStorage, ThrottlerGuard, ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import { BlocklistService } from './blocklist.service';

/**
 * Rate limit for the mobile routes only (ES-217). Used as @UseGuards(MobileThrottlerGuard) on mobile controllers,
 * with its own limits from MOBILE_THROTTLE_LIMIT / MOBILE_THROTTLE_TTL (see MobileModule).
 *
 * It is deliberately NOT a global guard: desktop staff must never be rate limited because of the app, and only
 * /api/v1/mobile is published to the internet. The tracker is the real client IP (req.ip, correct behind the tunnel
 * thanks to `trust proxy` in main.ts). Strict routes (activation, login) add their own @Throttle(...) later.
 *
 * It also refuses callers that staff blocked in the Control Center (a phone or an IP, ES-243) before any other work.
 */
@Injectable()
export class MobileThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    @Optional() private readonly blocklist?: BlocklistService,
  ) {
    super(options, storageService, reflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.blocklist) {
      const req = context.switchToHttp().getRequest();
      const device = req?.headers?.['x-device-id'];
      if (await this.blocklist.isBlocked(req?.ip, typeof device === 'string' ? device : undefined)) {
        throw new ForbiddenException({ statusCode: 403, code: 'ACCESS_BLOCKED', message: 'Access from this phone or network is blocked. Please contact the society.' });
      }
    }
    return super.canActivate(context);
  }
}
