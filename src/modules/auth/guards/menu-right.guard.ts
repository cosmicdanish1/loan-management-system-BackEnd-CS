import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AuthService } from '../auth.service';

export const REQUIRE_MENU_ACTION_KEY = 'requireMenuAction';

/**
 * Server-side enforcement of the Role Governance menu rights (Configure UserLevel Default Rights /
 * per-user rights). Until now those rights only decided which windows the app SHOWED; anybody with a
 * token could call the API directly. Mark a sensitive endpoint with the menu action that unlocks its
 * window (e.g. 'LOAN_EARLY_CLOSURE'): a user whose level/rights do not include it gets 403.
 * Levels in BYPASS_USER_LEVEL_IDS (administrators) are unrestricted, same as in the app.
 */
export const RequireMenuAction = (...actions: string[]) => SetMetadata(REQUIRE_MENU_ACTION_KEY, actions);

@Injectable()
export class MenuRightGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly dataSource: DataSource,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const actions = this.reflector.get<string[] | undefined>(REQUIRE_MENU_ACTION_KEY, context.getHandler());
    if (!actions || actions.length === 0) return true;
    const user = context.switchToHttp().getRequest().user;
    if (!user) return true; // not signed in: the JWT guard has already decided

    const rows = await this.dataSource.query(`SELECT userlevelid FROM usermaster WHERE userid = $1`, [user.id]);
    if (!rows.length) throw new ForbiddenException('User not found');
    const allowed = await this.authService.getAllowedActions(user.id, Number(rows[0].userlevelid));
    if (allowed === null) return true; // unrestricted level
    if (actions.some((a) => allowed.includes(a))) return true;
    throw new ForbiddenException({
      statusCode: 403,
      code: 'MENU_RIGHT_REQUIRED',
      message: 'Your user level does not have the right to use this function. Ask an administrator (Configure UserLevel Default Rights).',
    });
  }
}
