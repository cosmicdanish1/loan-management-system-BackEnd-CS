import { CanActivate, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * Saving Bank (SB) feature switch.
 *
 * The legacy system never had savings accounts (no table, no ledger rows), so the feature is OFF by default.
 * The code and the sbmaster table are kept; set SB_ENABLED=true in .env (and restart) to turn it back on.
 */
export function isSbEnabled(): boolean {
  return String(process.env.SB_ENABLED ?? '').trim().toLowerCase() === 'true';
}

export const SB_DISABLED_MESSAGE = 'Saving Bank accounts are not enabled for this society.';

export function assertSbEnabled(): void {
  if (!isSbEnabled()) throw new ForbiddenException(SB_DISABLED_MESSAGE);
}

/** Use with @UseGuards(SbEnabledGuard) on SB-only routes. */
@Injectable()
export class SbEnabledGuard implements CanActivate {
  canActivate(): boolean {
    assertSbEnabled();
    return true;
  }
}
