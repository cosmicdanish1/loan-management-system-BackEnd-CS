import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

// Same names RoleGuard treats as administrators (its "master bypass"), plus the legacy SYSTEM level.
const ADMIN_ROLE_NAMES = ['sample_1', 'administrator', 'admin', 'system'];

export const isAdminUser = (u: any): boolean => ADMIN_ROLE_NAMES.includes(String(u?.role || '').toLowerCase());

/** An administrator, or a user an administrator gave the "Manage Two-Factor (other users)" right. */
export const canManageTwoFactor = (u: any): boolean =>
  isAdminUser(u) || (Array.isArray(u?.permissions) && u.permissions.includes('manage_two_factor'));

/** ES-178: lets administrators AND holders of the Manage Two-Factor right use the "Users" tab endpoints. */
@Injectable()
export class TwoFaManageGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user;
    if (!canManageTwoFactor(user)) {
      throw new ForbiddenException('You need the "Manage Two-Factor" right for this');
    }
    return true;
  }
}
