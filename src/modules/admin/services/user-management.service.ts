import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike, In, DataSource } from 'typeorm';
import { UserRole, UserPermission } from '../../auth/entities/user.entity';
import { UserMaster, UserLevelMaster, LoginTime } from '../../auth/entities';
import { UserActivity } from '../entities/user-activity.entity';
import {
  CreateUserDto,
  UpdateUserDto,
  ChangePasswordDto,
  AdminChangePasswordDto,
  UserActivityDto,
  UserActivityResponseDto,
  RolePermissionsDto,
  UpdateUserRoleDto,
} from '../dto';
import { UserResponseDto } from '../../auth/dto';
import { roleFromLegacyLevel } from '../../auth/utils';

// usermaster is the single source of truth for user management — the separate
// modern `users` table it used to sync with (best-effort, via try/catch) has
// been retired: it had zero real accounts, since real login always checked
// usermaster first anyway. `id` everywhere below is usermaster.userid.
@Injectable()
export class UserManagementService implements OnModuleInit {
  private readonly logger = new Logger(UserManagementService.name);

  constructor(
    @InjectRepository(UserActivity)
    private userActivityRepository: Repository<UserActivity>,
    @InjectRepository(UserMaster)
    private userMasterRepository: Repository<UserMaster>,
    @InjectRepository(UserLevelMaster)
    private userLevelMasterRepository: Repository<UserLevelMaster>,
    @InjectRepository(LoginTime)
    private loginTimeRepository: Repository<LoginTime>,
    private readonly dataSource: DataSource,
  ) { }

  async onModuleInit() {
    await this.repairDatabaseSchema();
  }

  private async repairDatabaseSchema() {
    try {
      // Increase column sizes in legacy usermaster to accommodate modern hashes/long usernames
      await this.userMasterRepository.query(`
        ALTER TABLE "usermaster"
        ALTER COLUMN "susername" TYPE varchar(50),
        ALTER COLUMN "spassword" TYPE varchar(255)
      `);
      this.logger.log('Successfully updated legacy usermaster schema for synchronization.');
    } catch (err) {
      // If column doesn't exist or already updated, this might fail silently which is fine
      this.logger.log(`Legacy usermaster schema check/update skipped: ${err.message}`);
    }

    try {
      // usermaster is now the single source of truth for user management —
      // these fields used to live only on the separate modern `users` table
      // (which had zero real accounts; every real login already went through
      // usermaster). Idempotent: IF NOT EXISTS makes this safe to run on every boot.
      await this.userMasterRepository.query(`
        ALTER TABLE "usermaster"
        ADD COLUMN IF NOT EXISTS "email" varchar(100),
        ADD COLUMN IF NOT EXISTS "first_name" varchar(50),
        ADD COLUMN IF NOT EXISTS "last_name" varchar(50),
        ADD COLUMN IF NOT EXISTS "avatar" text,
        ADD COLUMN IF NOT EXISTS "permissions" text,
        ADD COLUMN IF NOT EXISTS "updated_at" timestamp,
        ADD COLUMN IF NOT EXISTS "force_logout_at" timestamp
      `);
      this.logger.log('Successfully ensured usermaster has modern user-management columns.');
    } catch (err) {
      this.logger.log(`usermaster modern-columns check/update skipped: ${err.message}`);
    }

    try {
      // user_preferences had a real FK constraint into the modern `users`
      // table (ON DELETE CASCADE) — blocks dropping that table entirely, and
      // was never actually correct: userId is populated from req.user.id on
      // the real login path, which is usermaster.userid, not users.id.
      await this.userMasterRepository.query(`
        ALTER TABLE "user_preferences"
        DROP CONSTRAINT IF EXISTS "FK_user_preferences_users"
      `);
      this.logger.log('Successfully dropped stale user_preferences -> users FK constraint.');
    } catch (err) {
      this.logger.log(`user_preferences FK constraint drop skipped: ${err.message}`);
    }

    try {
      // The modern `users` table has been fully retired — usermaster is now
      // the single source of truth (see createUser/updateUser/findAllUsers
      // etc. above). Nothing in the codebase queries `users` anymore and no
      // other table has a live FK into it (verified). Safe to drop.
      await this.userMasterRepository.query(`DROP TABLE IF EXISTS "users"`);
      this.logger.log('Successfully dropped retired "users" table.');
    } catch (err) {
      this.logger.log(`"users" table drop skipped: ${err.message}`);
    }

    try {
      // usermaster had NO primary key or unique constraint at all (confirmed
      // via pg_constraint — only NOT NULL). Combined with createUser()'s
      // unguarded MAX(userid)+1, concurrent creates silently produced
      // duplicate-userid rows (confirmed live: 5 parallel creates -> 2
      // duplicate pairs, all reporting success). Safe to add now — no
      // existing duplicates in real data (verified before adding this).
      await this.userMasterRepository.query(`ALTER TABLE "usermaster" ADD PRIMARY KEY ("userid")`);
      this.logger.log('Successfully added primary key constraint on usermaster.userid.');
    } catch (err) {
      this.logger.log(`usermaster primary key check/add skipped: ${err.message}`);
    }

    try {
      // Same gap as the userid PK above, for susername — the entity's
      // `unique: true` was ORM metadata only, never enforced by the DB.
      await this.userMasterRepository.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "usermaster_susername_unique" ON "usermaster" ("susername")`,
      );
      this.logger.log('Successfully ensured unique index on usermaster.susername.');
    } catch (err) {
      this.logger.log(`usermaster susername unique index check/add skipped: ${err.message}`);
    }
  }

  /**
   * Finds the legacy userlevelmaster row matching a modern role string
   * ('branch_manager'), normalizing for the format difference against real
   * legacy names ('BRANCH MANAGER'). Mints a genuinely new id (real
   * MAX(id)+1, never a hardcoded/colliding one) if no legacy level exists yet
   * for this role — e.g. MANAGER/ACCOUNTANT/LOAN_OFFICER, which exist in the
   * modern UserRole enum but have no legacy equivalent.
   */
  private async resolveOrCreateUserLevel(role: string): Promise<UserLevelMaster> {
    const normalizedRole = role.replace(/_/g, ' ').toUpperCase();
    let userLevel = await this.userLevelMasterRepository
      .createQueryBuilder('ul')
      .where(`UPPER(REPLACE(ul.userlevel, '_', ' ')) = :role`, { role: normalizedRole })
      .getOne();

    if (!userLevel) {
      const existingLevels = await this.userLevelMasterRepository.find({ order: { userlevelid: 'DESC' }, take: 1 });
      const nextId = existingLevels.length > 0 ? existingLevels[0].userlevelid + 1 : 0;
      userLevel = this.userLevelMasterRepository.create({ userlevelid: nextId, userlevel: role });
      await this.userLevelMasterRepository.save(userLevel);
    }

    return userLevel;
  }

  private async countUsersByRole(role: UserRole, activeOnly: boolean): Promise<number> {
    const normalizedRole = role.replace(/_/g, ' ').toUpperCase();
    const qb = this.userMasterRepository
      .createQueryBuilder('um')
      .innerJoin('um.userLevel', 'ul')
      .where(`UPPER(REPLACE(ul.userlevel, '_', ' ')) = :role`, { role: normalizedRole });
    if (activeOnly) qb.andWhere(`um.enableDisable = 'E'`);
    return qb.getCount();
  }

  async createUser(createUserDto: CreateUserDto): Promise<UserResponseDto> {
    const existingUsername = await this.userMasterRepository.findOne({
      where: { susername: createUserDto.username },
    });
    if (existingUsername) {
      throw new ConflictException('Username already exists');
    }

    if (createUserDto.email) {
      const existingEmail = await this.userMasterRepository.findOne({
        where: { email: createUserDto.email },
      });
      if (existingEmail) {
        throw new ConflictException('Email already exists');
      }
    }

    const permissions = createUserDto.permissions || this.getDefaultPermissions(createUserDto.role);
    const userLevel = await this.resolveOrCreateUserLevel(createUserDto.role);

    // usermaster has no PK/unique constraint enforced at the DB level on its
    // own (added at boot in repairDatabaseSchema, but that's a second line of
    // defense) — the unguarded MAX(userid)+1 read below silently produced
    // duplicate-userid rows under concurrent creates (confirmed live: 5
    // parallel requests -> 2 duplicate pairs, all reporting success). Same
    // transaction-scoped advisory-lock pattern used throughout this codebase
    // (interest.service.ts, utilities.service.ts) to serialize ID minting
    // without needing a real DB sequence.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    let saved: UserMaster;
    try {
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('usermaster.userid'))`);
      const maxResult = await queryRunner.query(`SELECT COALESCE(MAX(userid), 0) + 1 AS next_id FROM usermaster`);
      const nextId = Number(maxResult[0].next_id);

      const userMaster = queryRunner.manager.create(UserMaster, {
        userid: nextId,
        susername: createUserDto.username,
        spassword: createUserDto.password,
        userlevelid: userLevel.userlevelid,
        userLevel,
        enableDisable: createUserDto.isActive === false ? 'D' : 'E',
        loginStatus: 'N',
        passTransactionFlag: createUserDto.allowPassTransactions === false ? 'N' : 'Y',
        dateOfCreation: new Date(),
        email: createUserDto.email,
        firstName: createUserDto.firstName,
        lastName: createUserDto.lastName,
        avatar: createUserDto.avatar,
      });
      // `permissions` is a virtual getter/setter over `permissionsRaw`, not a
      // real @Column — repository.create() builds the entity via a plain merge
      // that skips it, so it must be assigned directly to fire the setter
      // (confirmed live: create()-inlined permissions silently persisted as
      // NULL, while direct assignment here and in updateUser() works).
      userMaster.permissions = permissions;
      saved = await queryRunner.manager.save(userMaster);
      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }

    // Populate userrights from userleveldefaultrights for this user level —
    // best-effort: a failure here shouldn't undo the user that was just created.
    try {
      const defaultRights = await this.userMasterRepository.query(
        `SELECT menuid FROM userleveldefaultrights WHERE userlevelid = $1`,
        [userLevel.userlevelid],
      );
      if (defaultRights.length > 0) {
        const values = defaultRights.map((r: any) => `(${saved.userid}, ${r.menuid})`).join(',');
        await this.userMasterRepository.query(
          `INSERT INTO userrights (userid, menuid) VALUES ${values} ON CONFLICT DO NOTHING`,
        );
      }
    } catch (err) {
      this.logger.error(`Failed to populate default rights for new user: ${err.message}`);
    }

    return this.mapUserMasterToResponseDto(saved);
  }

  async findAllUsers(
    page: number = 1,
    limit: number = 10,
    role?: UserRole,
    isActive?: boolean,
    username?: string,
  ): Promise<{
    users: UserResponseDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const p = Number(page) || 1;
    const l = Number(limit) || 10;

    const qb = this.userMasterRepository
      .createQueryBuilder('um')
      .leftJoinAndSelect('um.userLevel', 'ul')
      .orderBy('um.dateOfCreation', 'DESC', 'NULLS LAST')
      .skip((p - 1) * l)
      .take(l);

    if (username) qb.andWhere('um.susername ILIKE :username', { username: `%${username}%` });
    if (isActive !== undefined) qb.andWhere('um.enableDisable = :ed', { ed: isActive ? 'E' : 'D' });
    if (role) {
      const normalizedRole = role.replace(/_/g, ' ').toUpperCase();
      qb.andWhere(`UPPER(REPLACE(ul.userlevel, '_', ' ')) = :role`, { role: normalizedRole });
    }

    const [users, total] = await qb.getManyAndCount();

    return {
      users: users.map(user => this.mapUserMasterToResponseDto(user)),
      total,
      page: p,
      limit: l,
      totalPages: Math.ceil(total / l),
    };
  }

  async findUserById(id: number): Promise<UserResponseDto> {
    const userMaster = await this.userMasterRepository.findOne({ where: { userid: id } });
    if (!userMaster) {
      throw new NotFoundException('User not found');
    }
    return this.mapUserMasterToResponseDto(userMaster);
  }

  async updateUser(id: number, updateUserDto: UpdateUserDto): Promise<UserResponseDto> {
    const userMaster = await this.userMasterRepository.findOne({ where: { userid: id } });
    if (!userMaster) {
      throw new NotFoundException('User not found');
    }

    if (updateUserDto.email && updateUserDto.email !== userMaster.email) {
      const existingEmail = await this.userMasterRepository.findOne({ where: { email: updateUserDto.email } });
      if (existingEmail) {
        throw new ConflictException('Email already exists');
      }
    }

    if (updateUserDto.username && updateUserDto.username !== userMaster.susername) {
      const existingUsername = await this.userMasterRepository.findOne({ where: { susername: updateUserDto.username } });
      if (existingUsername) {
        throw new ConflictException('Username already exists');
      }
    }

    if (updateUserDto.username) userMaster.susername = updateUserDto.username;
    if (updateUserDto.password) userMaster.spassword = updateUserDto.password;
    if (updateUserDto.email !== undefined) userMaster.email = updateUserDto.email;
    if (updateUserDto.firstName !== undefined) userMaster.firstName = updateUserDto.firstName;
    if (updateUserDto.lastName !== undefined) userMaster.lastName = updateUserDto.lastName;
    if (updateUserDto.avatar !== undefined) userMaster.avatar = updateUserDto.avatar;
    if (updateUserDto.isActive !== undefined) userMaster.enableDisable = updateUserDto.isActive ? 'E' : 'D';
    if (updateUserDto.allowPassTransactions !== undefined) userMaster.passTransactionFlag = updateUserDto.allowPassTransactions ? 'Y' : 'N';

    if (updateUserDto.role) {
      const userLevel = await this.resolveOrCreateUserLevel(updateUserDto.role);
      // `userLevel` is an eager relation mapped to this same userlevelid
      // column — findOne() auto-loads it, and TypeORM derives the FK from
      // that stale relation object on save(), silently reverting a
      // scalar-only assignment. Both must be set.
      userMaster.userlevelid = userLevel.userlevelid;
      userMaster.userLevel = userLevel;
      userMaster.permissions = updateUserDto.permissions || this.getDefaultPermissions(updateUserDto.role);
    } else if (updateUserDto.permissions) {
      userMaster.permissions = updateUserDto.permissions;
    }

    userMaster.updatedAt = new Date();
    const updated = await this.userMasterRepository.save(userMaster);
    return this.mapUserMasterToResponseDto(updated);
  }

  async deleteUser(id: number): Promise<{ message: string }> {
    const userMaster = await this.userMasterRepository.findOne({ where: { userid: id } });
    if (!userMaster) {
      throw new NotFoundException('User not found');
    }

    const role = roleFromLegacyLevel(userMaster.userLevel?.userlevel || '');
    if (role === UserRole.ADMIN) {
      const adminCount = await this.countUsersByRole(UserRole.ADMIN, true);
      if (adminCount <= 1) {
        throw new ForbiddenException('Cannot delete the last admin user');
      }
    }

    await this.userMasterRepository.remove(userMaster);
    return { message: 'User deleted successfully' };
  }

  async changeUserPassword(
    userId: number,
    changePasswordDto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    const userMaster = await this.userMasterRepository.findOne({ where: { userid: userId } });
    if (!userMaster) {
      throw new NotFoundException('User not found');
    }

    const isCurrentPasswordValid = await userMaster.validatePassword(changePasswordDto.currentPassword);
    if (!isCurrentPasswordValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    userMaster.spassword = changePasswordDto.newPassword;
    await this.userMasterRepository.save(userMaster);

    return { message: 'Password changed successfully' };
  }

  async adminChangeUserPassword(
    userId: number,
    adminChangePasswordDto: AdminChangePasswordDto,
  ): Promise<{ message: string }> {
    const userMaster = await this.userMasterRepository.findOne({ where: { userid: userId } });
    if (!userMaster) {
      throw new NotFoundException('User not found');
    }

    userMaster.spassword = adminChangePasswordDto.newPassword;
    await this.userMasterRepository.save(userMaster);

    return { message: 'Password changed successfully' };
  }

  async updateUserRole(
    userId: number,
    updateUserRoleDto: UpdateUserRoleDto,
  ): Promise<UserResponseDto> {
    const userMaster = await this.userMasterRepository.findOne({ where: { userid: userId } });
    if (!userMaster) {
      throw new NotFoundException('User not found');
    }

    const currentRole = roleFromLegacyLevel(userMaster.userLevel?.userlevel || '');
    if (currentRole === UserRole.ADMIN && updateUserRoleDto.role !== UserRole.ADMIN) {
      const adminCount = await this.countUsersByRole(UserRole.ADMIN, true);
      if (adminCount <= 1) {
        throw new ForbiddenException('Cannot change role of the last admin user');
      }
    }

    const userLevel = await this.resolveOrCreateUserLevel(updateUserRoleDto.role);
    userMaster.userlevelid = userLevel.userlevelid;
    userMaster.userLevel = userLevel;
    userMaster.permissions = updateUserRoleDto.permissions || this.getDefaultPermissions(updateUserRoleDto.role);

    const updated = await this.userMasterRepository.save(userMaster);
    return this.mapUserMasterToResponseDto(updated);
  }

  /** Builds the small user summary embedded in activity responses, from usermaster. */
  private toActivityUserSummary(userMaster: UserMaster) {
    return {
      id: userMaster.userid,
      username: userMaster.susername,
      firstName: userMaster.firstName || userMaster.susername,
      lastName: userMaster.lastName || '',
    };
  }

  async logUserActivity(
    userId: number,
    activityDto: UserActivityDto,
  ): Promise<UserActivityResponseDto> {
    const userMaster = await this.userMasterRepository.findOne({ where: { userid: userId } });
    if (!userMaster) {
      throw new NotFoundException('User not found');
    }

    const activity = this.userActivityRepository.create({
      userId,
      ...activityDto,
    });

    const savedActivity = await this.userActivityRepository.save(activity);

    return {
      ...savedActivity,
      user: this.toActivityUserSummary(userMaster),
    };
  }

  async getUserActivities(
    userId: number,
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    activities: UserActivityResponseDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const [activities, total] = await this.userActivityRepository.findAndCount({
      where: { userId },
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    const userMaster = await this.userMasterRepository.findOne({ where: { userid: userId } });

    return {
      activities: activities.map(activity => ({
        ...activity,
        user: userMaster ? this.toActivityUserSummary(userMaster) : undefined,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getAllUserActivities(
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    activities: UserActivityResponseDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const [activities, total] = await this.userActivityRepository.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    const userIds = [...new Set(activities.map(a => a.userId))];
    const userMasters = userIds.length > 0
      ? await this.userMasterRepository.find({ where: { userid: In(userIds) } })
      : [];
    const byId = new Map(userMasters.map(u => [u.userid, u]));

    return {
      activities: activities.map(activity => {
        const userMaster = byId.get(activity.userId);
        return {
          ...activity,
          user: userMaster ? this.toActivityUserSummary(userMaster) : undefined,
        };
      }),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  getRolePermissions(): RolePermissionsDto[] {
    return Object.values(UserRole).map(role => ({
      role,
      permissions: this.getDefaultPermissions(role),
    }));
  }

  private mapUserMasterToResponseDto(userMaster: UserMaster): UserResponseDto {
    const role = roleFromLegacyLevel(userMaster.userLevel?.userlevel || '');
    return {
      id: userMaster.userid,
      username: userMaster.susername,
      email: userMaster.email || `${userMaster.susername.toLowerCase()}@bank.local`,
      firstName: userMaster.firstName || userMaster.susername,
      lastName: userMaster.lastName || '',
      fullName: userMaster.fullName,
      role: role as UserRole,
      permissions: userMaster.hasExplicitPermissions ? userMaster.permissions as UserPermission[] : this.getDefaultPermissions(role as UserRole),
      isActive: userMaster.isEnabled,
      allowPassTransactions: userMaster.canPassTransactions,
      avatar: userMaster.avatar || null,
      lastLoginAt: null,
      createdAt: userMaster.dateOfCreation,
    };
  }

  private getDefaultPermissions(role: UserRole): UserPermission[] {
    switch (role) {
      case UserRole.SYSTEM:
      case UserRole.ADMIN:
        return Object.values(UserPermission);

      case UserRole.BRANCH_MANAGER:
        return [
          UserPermission.READ_MEMBER,
          UserPermission.UPDATE_MEMBER,
          UserPermission.READ_LOAN,
          UserPermission.UPDATE_LOAN,
          UserPermission.APPROVE_LOAN,
          UserPermission.READ_DEPOSIT,
          UserPermission.UPDATE_DEPOSIT,
          UserPermission.READ_TRANSACTION,
          UserPermission.GENERATE_REPORTS,
          UserPermission.VIEW_FINANCIAL_REPORTS,
        ];

      case UserRole.OFFICER:
      case UserRole.PASSING_OFFICER:
        return [
          UserPermission.CREATE_MEMBER,
          UserPermission.READ_MEMBER,
          UserPermission.UPDATE_MEMBER,
          UserPermission.CREATE_LOAN,
          UserPermission.READ_LOAN,
          UserPermission.UPDATE_LOAN,
          UserPermission.READ_DEPOSIT,
          UserPermission.READ_TRANSACTION,
        ];

      case UserRole.AUDITOR:
        return [
          UserPermission.READ_MEMBER,
          UserPermission.READ_LOAN,
          UserPermission.READ_DEPOSIT,
          UserPermission.READ_TRANSACTION,
          UserPermission.GENERATE_REPORTS,
          UserPermission.VIEW_FINANCIAL_REPORTS,
        ];

      case UserRole.CASHIER:
      case UserRole.CLERK:
        return [
          UserPermission.READ_MEMBER,
          UserPermission.READ_LOAN,
          UserPermission.READ_DEPOSIT,
          UserPermission.CREATE_TRANSACTION,
          UserPermission.READ_TRANSACTION,
          UserPermission.UPDATE_TRANSACTION,
        ];

      case UserRole.USER:
      default:
        return [
          UserPermission.READ_MEMBER,
          UserPermission.READ_LOAN,
          UserPermission.READ_DEPOSIT,
          UserPermission.READ_TRANSACTION,
        ];
    }
  }

  async forceLogoutUser(username: string): Promise<{ message: string }> {
    const trimmedUsername = username.trim();

    // Use ILike for case-insensitive lookup to avoid 404s due to casing differences
    const userMaster = await this.userMasterRepository.findOne({
      where: { susername: ILike(trimmedUsername) }
    });

    if (!userMaster) {
      throw new NotFoundException(`User identity '${trimmedUsername}' not found in matrix`);
    }

    // Update login status. forceLogoutAt is what actually invalidates the
    // target's live token(s) (checked in JwtStrategy + AuthService.refreshToken)
    // — loginStatus alone is just the display flag this screen's own "Peek
    // Active" list reads.
    userMaster.loginStatus = 'N';
    userMaster.forceLogoutAt = new Date();
    await this.userMasterRepository.save(userMaster);

    // Update active sessions in logintime table
    const activeSessions = await this.loginTimeRepository.find({
      where: { userid: userMaster.userid, logoutTime: '' }
    });

    const now = new Date();
    const logoutTimeStr = now.toTimeString().split(' ')[0].substring(0, 8);

    for (const session of activeSessions) {
      session.logoutTime = logoutTimeStr;
      await this.loginTimeRepository.save(session);
    }

    return { message: `Session for '${username}' terminated successfully` };
  }

  async getActiveSessions(): Promise<any[]> {
    const activeUsers = await this.userMasterRepository.find({
      where: { loginStatus: 'Y' },
      relations: ['userLevel']
    });

    const activeSessions = [];

    for (const user of activeUsers) {
      const lastSession = await this.loginTimeRepository.findOne({
        where: { userid: user.userid, logoutTime: '' },
        order: { loginDate: 'DESC' }
      });

      activeSessions.push({
        userId: user.userid,
        username: user.susername,
        role: user.userLevel?.userlevel,
        loginDate: lastSession?.loginDate,
        loginTime: lastSession?.loginTime || 'Unknown'
      });
    }

    return activeSessions;
  }

  /** Login/logout history for a user, newest first. Login events are recorded against usermaster.userid. */
  async getUserLoginHistory(id: number, page = 1, limit = 20) {
    const userMaster = await this.userMasterRepository.findOne({ where: { userid: id } });
    if (!userMaster) {
      throw new NotFoundException(`No login records found for user id ${id}`);
    }

    const [rows, total] = await this.loginTimeRepository.findAndCount({
      where: { userid: userMaster.userid },
      order: { loginDate: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      userId: id,
      username: userMaster.susername,
      total,
      page: Number(page),
      limit: Number(limit),
      data: rows.map((r) => ({
        loginDate: r.loginDate,
        loginTime: r.loginTime,
        logoutTime: r.logoutTime || null,
        active: !r.logoutTime,
        sessionDurationMinutes: r.sessionDuration,
      })),
    };
  }
}
