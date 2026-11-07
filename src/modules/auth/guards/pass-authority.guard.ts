import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AuthService } from '../auth.service';

export const REQUIRE_PASS_AUTHORITY_KEY = 'requirePassAuthority';

/**
 * Maker-checker control (ES-362): passing, reversing or rejecting a voucher needs BOTH
 *  - the user's "Transaction Auth" switch (usermaster.pass_transaction_flag = 'Y', Create / Modify Users), and
 *  - the 'Pass Transactions' menu right of the user's level (Configure UserLevel Default Rights).
 * Until now neither was checked by the API, so any signed-in user could approve their own vouchers.
 * The flag is read from the database on every call, so switching it off takes effect immediately
 * (not only at the next login).
 */
export const RequirePassAuthority = () => SetMetadata(REQUIRE_PASS_AUTHORITY_KEY, true);

@Injectable()
export class PassAuthorityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly dataSource: DataSource,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.reflector.get<boolean | undefined>(REQUIRE_PASS_AUTHORITY_KEY, context.getHandler())) return true;
    const user = context.switchToHttp().getRequest().user;
    if (!user) return true; // not signed in: the JWT guard has already decided

    const rows = await this.dataSource.query(
      `SELECT userlevelid, pass_transaction_flag FROM usermaster WHERE userid = $1`,
      [user.id],
    );
    if (!rows.length) throw new ForbiddenException('User not found');

    if (String(rows[0].pass_transaction_flag || '').toUpperCase() !== 'Y') {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PASS_AUTHORITY_REQUIRED',
        message: 'Transaction Auth is switched off for your user, so you cannot pass, reverse or reject vouchers. Ask an administrator (Create / Modify Users).',
      });
    }

    const allowed = await this.authService.getAllowedActions(user.id, Number(rows[0].userlevelid));
    if (allowed !== null && !allowed.includes('PASS_TRANSACTIONS')) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'MENU_RIGHT_REQUIRED',
        message: 'Your user level does not have the Pass Transactions right. Ask an administrator (Configure UserLevel Default Rights).',
      });
    }
    return true;
  }
}
