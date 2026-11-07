import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

let ephemeral: string | null = null;

/**
 * Secret that signs and verifies MEMBER tokens. It must be different from JWT_SECRET (staff) so a member token can never
 * be accepted as a staff token and the other way round (ES-216).
 *
 * If JWT_MEMBER_SECRET is missing or too short the backend still starts (an older server that was updated without the
 * new setting must not fail to boot) but uses a random secret that only lives until the next restart, so members would
 * have to log in again after every restart. A loud warning is logged.
 */
export function resolveMemberSecret(config: ConfigService): string {
  const configured = config.get<string>('JWT_MEMBER_SECRET', '');
  const staff = config.get<string>('JWT_SECRET', '');
  if (configured && configured.length >= 32 && configured !== staff) return configured;

  if (!ephemeral) {
    ephemeral = crypto.randomBytes(48).toString('hex');
    new Logger('MobileAuth').warn(
      'JWT_MEMBER_SECRET is missing, shorter than 32 characters or equal to JWT_SECRET: using a temporary random member secret. ' +
        'Set a strong, different JWT_MEMBER_SECRET in .env before real members use the app.',
    );
  }
  return ephemeral;
}
