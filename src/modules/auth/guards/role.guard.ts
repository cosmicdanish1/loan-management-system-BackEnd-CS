import {
  Injectable,
  Logger,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole, UserPermission } from '../entities/user.entity';
import { ROLES_KEY, PERMISSIONS_KEY } from '../decorators';

@Injectable()
export class RoleGuard implements CanActivate {
  private readonly logger = new Logger(RoleGuard.name);

  constructor(private reflector: Reflector) { }

  canActivate(context: ExecutionContext): boolean {
    // Get required roles and permissions from decorators
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    const requiredPermissions = this.reflector.getAllAndOverride<UserPermission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If no roles or permissions are required, allow access
    if (!requiredRoles && !requiredPermissions) {
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
      this.logger.log(`Master bypass granted for role: ${userRole}`);
      return true;
    }

    // Check roles
    if (requiredRoles && requiredRoles.length > 0) {
      const normalizeRole = (r: string) => r.toLowerCase() === 'admin' ? 'administrator' : r.toLowerCase();

      const normalizedUserRole = normalizeRole(userRole || '');
      const normalizedRequiredRoles = requiredRoles.map(r => normalizeRole(r));

      this.logger.debug(`Normalized User role: "${normalizedUserRole}"`);
      this.logger.debug(`Normalized Required roles: ${JSON.stringify(normalizedRequiredRoles)}`);

      const hasRole = normalizedRequiredRoles.includes(normalizedUserRole);
      if (!hasRole) {
        this.logger.warn(`Access denied. Mismatch detected.`);
        throw new ForbiddenException(
          `Access denied. Required roles: ${requiredRoles.join(', ')}`,
        );
      }
    }

    // Check permissions
    if (requiredPermissions && requiredPermissions.length > 0) {
      const hasPermission = requiredPermissions.some(permission =>
        user.hasPermission(permission),
      );
      if (!hasPermission) {
        throw new ForbiddenException(
          `Access denied. Required permissions: ${requiredPermissions.join(', ')}`,
        );
      }
    }

    return true;
  }
}
