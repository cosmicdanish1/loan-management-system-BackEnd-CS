import { User, UserRole, UserPermission } from '../entities/user.entity';
import { UserMaster } from '../entities/user-master.entity';

/**
 * Legacy level name ('ADMINISTRATOR', 'BRANCH MANAGER') -> modern UserRole
 * value ('administrator', 'branch_manager') where one exists, else a best
 * effort lowercase/underscored fallback. Real usermaster names are uppercase
 * with spaces; comparing that raw string directly against the lowercase
 * enum values (as this used to) always fails, which — beyond guard checks
 * that separately re-normalize — also meant the frontend's role dropdown
 * showed blank when editing an existing user, since none of its lowercase
 * option values ever matched the raw uppercase role coming back from the API.
 */
export function roleFromLegacyLevel(levelName: string): string {
  if (!levelName) return UserRole.DATA_OPERATOR;
  const match = Object.values(UserRole).find(
    (r) => r.replace(/_/g, ' ').toUpperCase() === levelName.toUpperCase(),
  );
  return match || levelName.toLowerCase().replace(/ /g, '_');
}

/**
 * Bridges a real usermaster row into the User-shaped object guards/strategies
 * are typed against. This used to be duplicated between auth.service.ts and
 * jwt.strategy.ts — they drifted apart (the strategy's copy, which governs
 * permissions on every authenticated request, was missing the extra admin
 * grants the other copy had), so it's now a single shared function.
 */
export function mapUserMasterToUser(userMaster: UserMaster): User {
  const user = new User();
  user.id = userMaster.userid;
  user.username = userMaster.susername;
  user.email = userMaster.email || `${userMaster.susername}@example.com`;
  user.firstName = userMaster.firstName || userMaster.susername;
  user.lastName = userMaster.lastName || '';
  user.avatar = userMaster.avatar || undefined;
  user.role = roleFromLegacyLevel(userMaster.userLevel?.userlevel || '') as any;

  // usermaster.permissions is set explicitly by CreateModifyUsers/Role
  // Management; fall back to the hardcoded role-based derivation below for
  // rows that predate that column (or never had permissions assigned).
  if (userMaster.permissions.length > 0) {
    user.permissions = userMaster.permissions as UserPermission[];
  } else {
    const permissions = [UserPermission.READ_MEMBER];
    if (user.role === UserRole.ADMIN || user.role === UserRole.DATA_OPERATOR || (user.role as any) === 'admin' || (user.role as any) === 'sample_1') {
      permissions.push(UserPermission.MANAGE_USERS);
    }
    // Admin users from UserMaster were never granted MANAGE_SYSTEM_CONFIG,
    // DAY_END_OPERATIONS, or PERFORM_BACKUP. All three Financial Year write
    // endpoints and the DayEnd endpoint require MANAGE_SYSTEM_CONFIG — every
    // real admin was getting 403.
    if (user.role === UserRole.ADMIN || (user.role as any) === 'admin') {
      permissions.push(UserPermission.MANAGE_SYSTEM_CONFIG);
      permissions.push(UserPermission.DAY_END_OPERATIONS);
      permissions.push(UserPermission.PERFORM_BACKUP);
    }
    user.permissions = permissions;
  }
  user.isActive = userMaster.isEnabled;

  return user;
}
