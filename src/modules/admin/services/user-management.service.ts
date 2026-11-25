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
import { AlertBridge } from '../../alerts/alert-bridge';
import { PasswordHistoryService } from '../../shared/services/password-history.service';
import { resolvePostingDate, postingDateAsDate } from '../../shared/utils/posting-date';

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
    private readonly passwordHistory: PasswordHistoryService,
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

  /** Login names are unique ignoring letter case ('Admin' and 'admin' would be look-alike accounts). (ES-266) */
  private async usernameTaken(username: string, exceptUserId?: number): Promise<boolean> {
    const qb = this.userMasterRepository
      .createQueryBuilder('um')
      .where('LOWER(um.susername) = LOWER(:username)', { username: String(username).trim() });
    if (exceptUserId !== undefined) qb.andWhere('um.userid <> :exceptUserId', { exceptUserId });
    return (await qb.getCount()) > 0;
  }

  /**
   * The date stamped on a user record (created, enabled / disabled): the Day-End WORKING date as a date only, the way
   * the legacy window stamps it (every legacy DATE_OF_CREATION is a midnight date). Day-End > Date settings can switch
   * the window to the system date; without any working date the system date is used. (ES-646)
   */
  private async recordDate(): Promise<Date> {
    try {
      const r = await resolvePostingDate(this.dataSource, 'USER_MANAGEMENT');
      return postingDateAsDate(r.date);
    } catch {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    }
  }

  /** Who may hand out the top two levels: SYSTEM only by a system user, ADMINISTRATOR only by an administrator or system user. (ES-647) */
  private assertCanAssignRole(actorRole: unknown, role: unknown): void {
    const a = String(actorRole ?? '').toLowerCase();
    const r = String(role ?? '').toLowerCase();
    const actorIsSystem = a === 'system' || a === 'sample_1';
    const actorIsAdmin = actorIsSystem || a === 'administrator' || a === 'admin';
    if (r === 'system' && !actorIsSystem) {
      throw new ForbiddenException('Only a SYSTEM user can create or assign the SYSTEM level.');
    }
    if ((r === 'administrator' || r === 'admin') && !actorIsAdmin) {
      throw new ForbiddenException('Only an administrator can create or assign the ADMINISTRATOR level.');
    }
  }

  /** The role of whoever is acting, read from the account itself (the token only carries an id). */
  private async actorRoleById(actorId?: number): Promise<string> {
    if (actorId === undefined || !Number.isFinite(actorId)) return '';
    const rows = await this.dataSource.query(
      `SELECT ul.userlevel FROM usermaster um JOIN userlevelmaster ul ON ul.userlevelid = um.userlevelid WHERE um.userid = $1`,
      [actorId],
    );
    return String(rows?.[0]?.userlevel ?? '').toLowerCase().replace(/ /g, '_');
  }

  /** Menu ids that exist in menumaster, or a 400 naming the ones that do not. */
  private async cleanMenuIds(menuIds: unknown): Promise<number[]> {
    if (!Array.isArray(menuIds) || menuIds.some((m) => !Number.isInteger(m) || m < 0)) {
      throw new BadRequestException('menuIds must be a list of window ids.');
    }
    const ids = [...new Set(menuIds as number[])];
    if (ids.length > 1000) throw new BadRequestException('Too many window rights in one save.');
    if (ids.length === 0) return ids;
    const found = await this.dataSource.query(`SELECT menuid FROM menumaster WHERE menuid = ANY($1::int[])`, [ids]);
    const have = new Set(found.map((r: any) => Number(r.menuid)));
    const unknown = ids.filter((i) => !have.has(i));
    if (unknown.length > 0) throw new BadRequestException(`Unknown window right${unknown.length > 1 ? 's' : ''}: ${unknown.slice(0, 5).join(', ')}.`);
    return ids;
  }

  /** Replaces a person's own window rights in one transaction (one lock per person). */
  private async replaceUserRights(userid: number, menuIds: number[]): Promise<void> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`userrights:${userid}`]);
      await qr.query(`DELETE FROM userrights WHERE userid = $1`, [userid]);
      if (menuIds.length > 0) {
        await qr.query(`INSERT INTO userrights (userid, menuid) SELECT $1, m FROM unnest($2::int[]) AS m ON CONFLICT DO NOTHING`, [userid, menuIds]);
      }
      await qr.commitTransaction();
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  /** The window rights a level starts a new person with. */
  private async levelDefaultMenuIds(userlevelid: number): Promise<number[]> {
    const rows = await this.dataSource.query(`SELECT menuid FROM userleveldefaultrights WHERE userlevelid = $1 ORDER BY menuid`, [userlevelid]);
    return rows.map((r: any) => Number(r.menuid));
  }

  private static isUnrestrictedLevel(levelName: string): boolean {
    return ['ADMINISTRATOR', 'SYSTEM'].includes(String(levelName || '').toUpperCase());
  }

  /** One person's window rights: what they have, what their level starts with, and every window. (ES-645) */
  async getUserMenuRights(id: number) {
    const um = await this.userMasterRepository.findOne({ where: { userid: id }, relations: ['userLevel'] });
    if (!um) throw new NotFoundException('User not found');
    const own: number[] = (await this.dataSource.query(`SELECT menuid FROM userrights WHERE userid = $1 ORDER BY menuid`, [id])).map((r: any) => Number(r.menuid));
    const defaults = await this.levelDefaultMenuIds(um.userlevelid);
    const menus = await this.dataSource.query(`SELECT menuid, menuname, menudesc FROM menumaster ORDER BY menuid`);
    return {
      userid: id,
      username: um.susername,
      userlevelid: um.userlevelid,
      level: um.userLevel?.userlevel ?? '',
      unrestricted: UserManagementService.isUnrestrictedLevel(um.userLevel?.userlevel ?? ''),
      custom: own.length > 0,
      granted: own.length > 0 ? own : defaults,
      defaults,
      menus,
    };
  }

  /** Sets one person's own window rights. Takes effect on the very next request (the server reads them every time). */
  async setUserMenuRights(id: number, menuIds: unknown): Promise<{ userid: number; count: number }> {
    const ids = await this.cleanMenuIds(menuIds);
    const um = await this.userMasterRepository.findOne({ where: { userid: id }, relations: ['userLevel'] });
    if (!um) throw new NotFoundException('User not found');
    if (UserManagementService.isUnrestrictedLevel(um.userLevel?.userlevel ?? '')) {
      throw new BadRequestException('Administrators and SYSTEM users always have every right, so their window rights cannot be set.');
    }
    if (ids.length === 0) throw new BadRequestException('A user needs at least one window right.');
    await this.replaceUserRights(id, ids);
    return { userid: id, count: ids.length };
  }

  /**
   * The login name as it will be stored: no spaces around it, 1 to 20 characters (the legacy column is varchar(20); a longer
   * name used to fail with a database error), letters, digits, dot, underscore and hyphen only (ES-649).
   */
  private cleanUsername(raw: unknown): string {
    const name = String(raw ?? '').trim();
    if (!name) throw new BadRequestException('User name is required.');
    if (name.length > 20) throw new BadRequestException('User name can be at most 20 characters.');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new BadRequestException('User name can contain only letters, digits, dot, underscore and hyphen (no spaces).');
    return name;
  }

  async createUser(createUserDto: CreateUserDto, actor?: any): Promise<UserResponseDto> {
    createUserDto.username = this.cleanUsername(createUserDto.username);
    this.assertCanAssignRole(actor?.role, createUserDto.role);
    if (await this.usernameTaken(createUserDto.username)) {
      throw new ConflictException('Username already exists');
    }
    const ownMenuIds = (createUserDto as any).menuIds !== undefined ? await this.cleanMenuIds((createUserDto as any).menuIds) : null;
    const stamp = await this.recordDate();

    if (createUserDto.email) {
      const existingEmail = await this.userMasterRepository.findOne({
        where: { email: createUserDto.email },
      });
      if (existingEmail) {
        throw new ConflictException('Email already exists');
      }
    }

    let permissions = createUserDto.permissions || this.getDefaultPermissions(createUserDto.role);
    // Only an administrator may make someone an approver (ES-124).
    const actorRole = String(actor?.role || '').toLowerCase();
    if (!['admin', 'administrator', 'system', 'sample_1'].includes(actorRole)) {
      permissions = permissions.filter((p) => p !== UserPermission.APPROVE_ACTIONS && p !== UserPermission.MANAGE_TWO_FACTOR);
    }
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
        passTransactionFlag: createUserDto.allowPassTransactions === true ? 'Y' : 'N',
        dateOfCreation: stamp,
        dateOfDisableEnable: stamp, // legacy fills both with the creation date
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
      // ES-655: user ids are MAX+1, so an id can be reused; a new person starts with an empty history, never with the
      // remembered passwords of whoever had that id before
      try { await this.dataSource.query(`DELETE FROM password_history WHERE user_id = $1`, [saved.userid]); } catch { /* table appears with the first password change */ }
      await this.passwordHistory.recordHash(saved.userid, saved.spassword); // ES-207: the first password counts as used
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }

    // Populate userrights from userleveldefaultrights for this user level —
    // best-effort: a failure here shouldn't undo the user that was just created.
    try {
      // the window rights chosen on the screen, else the level's defaults (legacy: the lists start from the level)
      const startRights = ownMenuIds ?? (await this.levelDefaultMenuIds(userLevel.userlevelid));
      // always replaced, even with an empty list: user ids are MAX+1, so an id can be reused and rows left by an earlier
      // person of that id (see ES-651) must never become the new person's rights
      await this.replaceUserRights(saved.userid, startRights);
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

  async updateUser(id: number, updateUserDto: UpdateUserDto, actorId?: number): Promise<UserResponseDto> {
    const userMaster = await this.userMasterRepository.findOne({ where: { userid: id }, relations: ['userLevel'] });
    if (!userMaster) {
      throw new NotFoundException('User not found');
    }
    // Setting a password here is a password reset: same rule as the dedicated reset (not for administrators).
    if (updateUserDto.password) this.assertCanResetPassword(userMaster, actorId);
    if (updateUserDto.username !== undefined) updateUserDto.username = this.cleanUsername(updateUserDto.username);
    if (updateUserDto.role !== undefined) this.assertCanAssignRole(await this.actorRoleById(actorId), updateUserDto.role);
    const ownMenuIds = (updateUserDto as any).menuIds !== undefined ? await this.cleanMenuIds((updateUserDto as any).menuIds) : null;
    const levelBefore = userMaster.userlevelid;

    // The last enabled administrator can be neither demoted nor disabled, whichever endpoint is used (ES-400)
    const currentRole = roleFromLegacyLevel(userMaster.userLevel?.userlevel || '');
    const losesAdmin = currentRole === UserRole.ADMIN && userMaster.enableDisable === 'E'
      && ((updateUserDto.role !== undefined && updateUserDto.role !== UserRole.ADMIN) || updateUserDto.isActive === false);
    if (losesAdmin && (await this.countUsersByRole(UserRole.ADMIN, true)) <= 1) {
      throw new ForbiddenException('Cannot demote or disable the last admin user');
    }

    if (updateUserDto.email && updateUserDto.email !== userMaster.email) {
      const existingEmail = await this.userMasterRepository.findOne({ where: { email: updateUserDto.email } });
      if (existingEmail) {
        throw new ConflictException('Email already exists');
      }
    }

    if (updateUserDto.username && updateUserDto.username !== userMaster.susername) {
      if (await this.usernameTaken(updateUserDto.username, userMaster.userid)) {
        throw new ConflictException('Username already exists');
      }
    }

    if (updateUserDto.username) userMaster.susername = updateUserDto.username;
    if (updateUserDto.password) {
      await this.passwordHistory.assertNotReused(userMaster.userid, updateUserDto.password); // ES-207
      userMaster.spassword = updateUserDto.password;
      // a reset ends the person's existing sessions (ES-297): whoever knew the old password must sign in again
      userMaster.forceLogoutAt = UserManagementService.sessionCutoff();
    }
    if (updateUserDto.email !== undefined) userMaster.email = updateUserDto.email;
    if (updateUserDto.firstName !== undefined) userMaster.firstName = updateUserDto.firstName;
    if (updateUserDto.lastName !== undefined) userMaster.lastName = updateUserDto.lastName;
    if (updateUserDto.avatar !== undefined) userMaster.avatar = updateUserDto.avatar;
    if (updateUserDto.isActive !== undefined) {
      const next = updateUserDto.isActive ? 'E' : 'D';
      // legacy keeps the date the account was last enabled / disabled
      if (next !== userMaster.enableDisable) userMaster.dateOfDisableEnable = await this.recordDate();
      userMaster.enableDisable = next;
    }
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
    // Window rights: the ones sent from the screen, or (when the level changed) the new level's defaults, as legacy does.
    // An unrestricted level never keeps own rights (they would not be enforced and only mislead).
    const unrestricted = UserManagementService.isUnrestrictedLevel(updated.userLevel?.userlevel ?? '');
    if (unrestricted) {
      if (updated.userlevelid !== levelBefore) await this.replaceUserRights(updated.userid, []);
    } else if (ownMenuIds !== null) {
      if (ownMenuIds.length === 0) throw new BadRequestException('A user needs at least one window right.');
      await this.replaceUserRights(updated.userid, ownMenuIds);
    } else if (updated.userlevelid !== levelBefore) {
      await this.replaceUserRights(updated.userid, await this.levelDefaultMenuIds(updated.userlevelid));
    }
    return this.mapUserMasterToResponseDto(updated);
  }

  async deleteUser(id: number, actorId?: number): Promise<{ message: string }> {
    // Deleting your own account would lock you out (ES-258); same rule as the password reset
    if (actorId !== undefined && Number.isFinite(actorId) && actorId === id) {
      throw new ForbiddenException('You cannot delete your own account.');
    }
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
    // the person's own window rights go with them (ES-651): they used to stay behind as rows for a user that no longer exists
    try {
      await this.dataSource.query(`DELETE FROM userrights WHERE userid = $1`, [id]);
      await this.dataSource.query(`DELETE FROM password_history WHERE user_id = $1`, [id]); // ES-655: the remembered passwords go too
      await this.dataSource.query(`DELETE FROM logintime WHERE userid = $1`, [id]); // new ids are max+1: the sign-in history must not pass to the next person with the same id
    } catch (e) {
      this.logger.warn(`Could not remove the window rights of deleted user ${id}: ${(e as Error).message}`);
    }
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

    await this.passwordHistory.assertNotReused(userMaster.userid, changePasswordDto.newPassword); // ES-207
    userMaster.spassword = changePasswordDto.newPassword;
    await this.userMasterRepository.save(userMaster);
    await this.passwordHistory.recordHash(userMaster.userid, userMaster.spassword);

    return { message: 'Password changed successfully' };
  }

  /** Cut-off for "tokens issued before this are void": token iat has second precision, so truncate to the second. */
  private static sessionCutoff(): Date {
    return new Date(Math.floor(Date.now() / 1000) * 1000);
  }

  /** An administrator may reset the password of a user who is not an administrator. */
  private static readonly ADMIN_LEVELS = ['ADMINISTRATOR', 'SYSTEM'];

  private assertCanResetPassword(target: UserMaster, actorId?: number): void {
    const level = String((target as any).userLevel?.userlevel || '').toUpperCase();
    if (actorId !== undefined && target.userid === actorId) {
      throw new ForbiddenException('Use Change Password to change your own password.');
    }
    if (UserManagementService.ADMIN_LEVELS.includes(level)) {
      throw new ForbiddenException('An administrator\'s password cannot be reset by another administrator. They can change their own, or use Forgot password on the sign-in page.');
    }
  }

  async adminChangeUserPassword(
    userId: number,
    adminChangePasswordDto: AdminChangePasswordDto,
    actorId?: number,
  ): Promise<{ message: string }> {
    const userMaster = await this.userMasterRepository.findOne({ where: { userid: userId }, relations: ['userLevel'] });
    if (!userMaster) {
      throw new NotFoundException('User not found');
    }
    this.assertCanResetPassword(userMaster, actorId);

    await this.passwordHistory.assertNotReused(userMaster.userid, adminChangePasswordDto.newPassword); // ES-207
    userMaster.spassword = adminChangePasswordDto.newPassword;
    // every token issued before the reset stops working, so a session that used the old password ends now
    userMaster.forceLogoutAt = UserManagementService.sessionCutoff();
    await this.userMasterRepository.save(userMaster);
    await this.passwordHistory.recordHash(userMaster.userid, userMaster.spassword);

    return { message: 'Password changed successfully' };
  }

  async updateUserRole(
    userId: number,
    updateUserRoleDto: UpdateUserRoleDto,
    actorId?: number,
  ): Promise<UserResponseDto> {
    const userMaster = await this.userMasterRepository.findOne({ where: { userid: userId }, relations: ['userLevel'] });
    if (!userMaster) {
      throw new NotFoundException('User not found');
    }

    const currentRole = roleFromLegacyLevel(userMaster.userLevel?.userlevel || '');
    this.assertCanAssignRole(await this.actorRoleById(actorId), updateUserRoleDto.role);
    if (currentRole === UserRole.ADMIN && updateUserRoleDto.role !== UserRole.ADMIN) {
      const adminCount = await this.countUsersByRole(UserRole.ADMIN, true);
      if (adminCount <= 1) {
        throw new ForbiddenException('Cannot change role of the last admin user');
      }
    }

    const userLevel = await this.resolveOrCreateUserLevel(updateUserRoleDto.role);
    const levelBefore = userMaster.userlevelid;
    userMaster.userlevelid = userLevel.userlevelid;
    userMaster.userLevel = userLevel;
    userMaster.permissions = updateUserRoleDto.permissions || this.getDefaultPermissions(updateUserRoleDto.role);

    const updated = await this.userMasterRepository.save(userMaster);
    if (updated.userlevelid !== levelBefore) {
      await this.replaceUserRights(updated.userid, UserManagementService.isUnrestrictedLevel(userLevel.userlevel) ? [] : await this.levelDefaultMenuIds(updated.userlevelid));
    }
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
    const roles = Object.values(UserRole).map(role => ({
      role,
      permissions: this.getDefaultPermissions(role),
    }));
    // Not a role: puts the Approver (OTP) right into the Access Privilege Matrix pool without
    // making it part of any role's default rights.
    return [...roles, { role: 'approver_pool' as any, permissions: [UserPermission.APPROVE_ACTIONS, UserPermission.MANAGE_TWO_FACTOR] }];
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
        // Approver (OTP) is never a default right: it is granted per user by an administrator.
        return Object.values(UserPermission).filter((p) => p !== UserPermission.APPROVE_ACTIONS && p !== UserPermission.MANAGE_TWO_FACTOR);

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
      // % and _ are LIKE wildcards: escape them so the name is matched literally ('%' must not match the first user) (ES-400)
      where: { susername: ILike(trimmedUsername.replace(/[\\%_]/g, (c) => `\\${c}`)) },
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
      session.logoutAt = now;
      await this.loginTimeRepository.save(session);
    }

    // the person is no longer online: drop them from the live list at once, not at the next sweep
    AlertBridge.get()?.forgetPresence?.(String(userMaster.userid));

    return { message: `Session for '${username}' terminated successfully` };
  }

  /**
   * Live users: every enabled user as one card. `live` is true while the app of that user is still sending its minute
   * heartbeat (right after a backend restart, before any heartbeat could arrive, the sign-in flag is used instead).
   * Live people come first, then the most recently seen. (Logout User, "who is using the app right now")
   */
  async getLiveUsers(): Promise<{ generatedAt: string; liveCount: number; totalCount: number; users: any[] }> {
    const users = await this.userMasterRepository.find({ where: { enableDisable: 'E' }, relations: ['userLevel'] });
    const bridge = AlertBridge.get();
    const onlineIds = bridge?.onlineUserIds();
    const presence = new Map<string, any>();
    for (const p of bridge?.onlineNow?.() ?? []) presence.set(String(p.username).toLowerCase(), p);
    const trustHeartbeat = !!onlineIds && process.uptime() > 180;

    const latest: any[] = await this.userMasterRepository.query(
      `SELECT DISTINCT ON (userid) userid, login_date, login_time, logout_time, working_date::text AS working_date, logout_at
         FROM logintime ORDER BY userid, login_date DESC`,
    );
    const byUser = new Map<number, any>(latest.map((r) => [Number(r.userid), r]));
    const now = Date.now();

    const cards = users.map((u) => {
      const s = byUser.get(u.userid);
      const online = trustHeartbeat ? onlineIds!.has(String(u.userid)) : u.loginStatus === 'Y' || !!onlineIds?.has(String(u.userid));
      const p = presence.get(String(u.susername).toLowerCase());
      const open = !!s && !s.logout_time;
      const startedAt: Date | null = online && open && s?.login_date ? new Date(s.login_date) : null;
      return {
        userId: u.userid,
        username: u.susername,
        fullName: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || null,
        role: u.userLevel?.userlevel ?? '',
        live: online,
        loginDate: s?.working_date ?? null,
        loginTime: s?.login_time ?? null,
        loginAt: s?.login_date ? new Date(s.login_date).toISOString() : null,
        logoutTime: s?.logout_time || null,
        sessionMinutes: startedAt ? Math.max(0, Math.round((now - startedAt.getTime()) / 60000)) : null,
        lastSeen: p?.lastSeen ?? null,
        host: p?.host ?? null,
        ip: p?.ip ?? null,
        version: p?.version ?? null,
      };
    });

    cards.sort((a, b) =>
      Number(b.live) - Number(a.live)
      || String(b.loginAt ?? '').localeCompare(String(a.loginAt ?? ''))
      || a.username.localeCompare(b.username));

    return {
      generatedAt: new Date().toISOString(),
      liveCount: cards.filter((c) => c.live).length,
      totalCount: cards.length,
      users: cards,
    };
  }

  /**
   * Analytics for the Logout User window over the last `days` days (1 to 365): sessions and distinct people per day,
   * the busiest hours, the average session length, the most active people, and the sessions that never closed.
   * Days are real calendar days of the sign-in (the working date can lie weeks behind the calendar, so it is not used here).
   */
  async getSessionAnalytics(days = 30) {
    const span = Math.min(365, Math.max(1, Math.floor(Number(days)) || 30));
    const since = `(CURRENT_DATE - ($1::int - 1))`;
    const dayOf = `login_date::date`;

    const [totals] = await this.userMasterRepository.query(
      `SELECT count(*)::int AS sessions,
              count(DISTINCT userid)::int AS people,
              COALESCE(round(avg(EXTRACT(EPOCH FROM (logout_at - login_date)) / 60)
                       FILTER (WHERE logout_at IS NOT NULL AND logout_at > login_date AND logout_at - login_date < interval '24 hours'))::int, NULL) AS avg_minutes,
              count(*) FILTER (WHERE logout_time = '' AND login_date < now() - interval '1 day')::int AS never_closed
         FROM logintime WHERE ${dayOf} >= ${since}`,
      [span],
    );
    const perDayRows: any[] = await this.userMasterRepository.query(
      `SELECT ${dayOf}::text AS day, count(*)::int AS sessions, count(DISTINCT userid)::int AS people
         FROM logintime WHERE ${dayOf} >= ${since} GROUP BY 1 ORDER BY 1`,
      [span],
    );
    const hourRows: any[] = await this.userMasterRepository.query(
      `SELECT EXTRACT(HOUR FROM login_date)::int AS hour, count(*)::int AS sessions
         FROM logintime WHERE ${dayOf} >= ${since} GROUP BY 1`,
      [span],
    );
    const topRows: any[] = await this.userMasterRepository.query(
      `SELECT u.susername AS username, count(*)::int AS sessions, max(l.login_date) AS last_login
         FROM logintime l JOIN usermaster u ON u.userid = l.userid
        WHERE l.login_date::date >= ${since}
        GROUP BY u.susername ORDER BY sessions DESC, u.susername LIMIT 8`,
      [span],
    );
    const [never] = await this.userMasterRepository.query(
      `SELECT count(*)::int AS n FROM usermaster u
        WHERE u.enable_disable = 'E' AND NOT EXISTS (SELECT 1 FROM logintime l WHERE l.userid = u.userid)`,
    );

    // one entry per day of the span, zero where nobody signed in
    const map = new Map(perDayRows.map((r) => [r.day, r]));
    const perDay: { day: string; sessions: number; people: number }[] = [];
    const [ty, tm, td] = (await this.todayText()).split('-').map(Number);
    for (let i = span - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(ty, tm - 1, td - i));
      const key = d.toISOString().slice(0, 10);
      const r = map.get(key);
      perDay.push({ day: key, sessions: r?.sessions ?? 0, people: r?.people ?? 0 });
    }
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, sessions: hourRows.find((r) => r.hour === h)?.sessions ?? 0 }));

    return {
      days: span,
      totals: {
        sessions: totals?.sessions ?? 0,
        people: totals?.people ?? 0,
        avgMinutes: totals?.avg_minutes ?? null,
        neverClosed: totals?.never_closed ?? 0,
        neverSignedIn: never?.n ?? 0,
        liveNow: AlertBridge.get()?.onlineUserIds()?.size ?? 0,
      },
      perDay,
      hours,
      topUsers: topRows.map((r) => ({ username: r.username, sessions: r.sessions, lastLogin: r.last_login ? new Date(r.last_login).toISOString() : null })),
    };
  }

  /** Today as YYYY-MM-DD (server clock): the last day of the analytics span. */
  private async todayText(): Promise<string> {
    const [r] = await this.userMasterRepository.query(`SELECT CURRENT_DATE::text AS d`);
    return r.d;
  }

  async getActiveSessions(): Promise<any[]> {
    const activeUsers = await this.userMasterRepository.find({
      where: { loginStatus: 'Y' },
      relations: ['userLevel']
    });

    const activeSessions = [];

    // ES-114: loginStatus='Y' is set at login and cleared at logout, so a closed app / power cut / crash left the user
    // "active" forever. The app sends a heartbeat every minute; a user who has gone silent is not signed in any more.
    // Right after a backend restart nobody has had time to send a heartbeat yet, so the list is not filtered then.
    const onlineIds = AlertBridge.get()?.onlineUserIds();
    const filterByHeartbeat = !!onlineIds && process.uptime() > 180;

    for (const user of activeUsers) {
      if (filterByHeartbeat && !onlineIds!.has(String(user.userid))) {
        // gone silent: close the stale session so the flag and the list stay truthful
        try {
          const now = new Date();
          const logoutTimeStr = now.toTimeString().split(' ')[0].substring(0, 8);
          const open = await this.loginTimeRepository.find({ where: { userid: user.userid, logoutTime: '' } });
          for (const s of open) { s.logoutTime = logoutTimeStr; s.logoutAt = now; await this.loginTimeRepository.save(s); }
          user.loginStatus = 'N' as any;
          await this.userMasterRepository.save(user);
        } catch { /* cleanup is best effort; the user is still left out of the list */ }
        continue;
      }
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
