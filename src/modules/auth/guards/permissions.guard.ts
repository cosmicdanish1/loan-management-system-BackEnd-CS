import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserPermission } from '../entities/user.entity';
import { PERMISSIONS_KEY } from '../decorators';

// A user flagged for TRANSACTION AUTH (usermaster.pass_transaction_flag, set
// in Create/Modify Users) is treated as having full loan authority — this
// mirrors the app's existing "pass transactions" concept (disbursement/
// posting authority) rather than requiring every granular loan permission to
// be individually granted. Scoped to loan permissions only: it does not grant
// deposit/member/admin access, so it can't be used to bypass unrelated modules.
const LOAN_PERMISSIONS: UserPermission[] = [
  UserPermission.CREATE_LOAN,
  UserPermission.READ_LOAN,
  UserPermission.UPDATE_LOAN,
  UserPermission.DELETE_LOAN,
  UserPermission.APPROVE_LOAN,
];

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) { }

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<UserPermission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // MASTER BYPASS for setup roles
    const userRole = user.role?.toLowerCase();
    if (userRole === 'sample_1' || userRole === 'administrator' || userRole === 'admin') {
      return true;
    }

    // TRANSACTION AUTH bypass — see LOAN_PERMISSIONS above.
    if (user.canPassTransactions && requiredPermissions.every(p => LOAN_PERMISSIONS.includes(p))) {
      return true;
    }

    const hasPermission = requiredPermissions.some(permission =>
      user.hasPermission(permission),
    );

    if (!hasPermission) {
      throw new ForbiddenException(
        `Access denied. Required permissions: ${requiredPermissions.join(', ')}`,
      );
    }

    return true;
  }
}
