import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limit for the mobile routes only (ES-217). Used as @UseGuards(MobileThrottlerGuard) on mobile controllers,
 * with its own limits from MOBILE_THROTTLE_LIMIT / MOBILE_THROTTLE_TTL (see MobileModule).
 *
 * It is deliberately NOT a global guard: desktop staff must never be rate limited because of the app, and only
 * /api/v1/mobile is published to the internet. The tracker is the real client IP (req.ip, correct behind the tunnel
 * thanks to `trust proxy` in main.ts). Strict routes (activation, login) add their own @Throttle(...) later.
 */
@Injectable()
export class MobileThrottlerGuard extends ThrottlerGuard {}
