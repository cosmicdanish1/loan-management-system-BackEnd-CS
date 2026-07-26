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
import { Repository, FindManyOptions, ILike } from 'typeorm';
import { User, UserRole, UserPermission } from '../../auth/entities/user.entity';
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
import * as bcrypt from 'bcrypt';

@Injectable()
export class UserManagementService implements OnModuleInit {
  private readonly logger = new Logger(UserManagementService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserActivity)
    private userActivityRepository: Repository<UserActivity>,
    @InjectRepository(UserMaster)
    private userMasterRepository: Repository<UserMaster>,
    @InjectRepository(UserLevelMaster)
    private userLevelMasterRepository: Repository<UserLevelMaster>,
    @InjectRepository(LoginTime)
    private loginTimeRepository: Repository<LoginTime>,
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
  }

  async createUser(createUserDto: CreateUserDto): Promise<UserResponseDto> {
    // Check if username already exists
    const existingUsername = await this.userRepository.findOne({
      where: { username: createUserDto.username },
    });

    if (existingUsername) {
      throw new ConflictException('Username already exists');
    }

    // Check if email already exists
    const existingEmail = await this.userRepository.findOne({
      where: { email: createUserDto.email },
    });

    if (existingEmail) {
      throw new ConflictException('Email already exists');
    }

    // Set default permissions if not provided
    const permissions = createUserDto.permissions || this.getDefaultPermissions(createUserDto.role);

    // Find the next available ID manually (fallback for schemas without auto-increment)
    const lastUser = await this.userRepository.find({
      order: { id: 'DESC' } as any,
      take: 1
    });
    const nextId = lastUser.length > 0 ? lastUser[0].id + 1 : 1;

    // Create new user in modern table
    const user = this.userRepository.create({
      ...createUserDto,
      id: nextId,
      permissions,
    });

    const savedUser = await this.userRepository.save(user);

    // SYNCHRONIZATION: Create in legacy UserMaster table
    try {
      // Find or create appropriate user level
      let userLevel = await this.userLevelMasterRepository.findOne({
        where: { userlevel: createUserDto.role }
      });

      if (!userLevel) {
        // Fallback or create default levels if missing
        const levelId = this.getLegacyLevelId(createUserDto.role);
        userLevel = this.userLevelMasterRepository.create({
          userlevelid: levelId,
          userlevel: createUserDto.role
        });
        await this.userLevelMasterRepository.save(userLevel);
      }

      const userMaster = this.userMasterRepository.create({
        userid: savedUser.id,
        susername: createUserDto.username,
        spassword: createUserDto.password,
        userlevelid: userLevel.userlevelid,
        enableDisable: 'E',
        loginStatus: 'N',
        passTransactionFlag: 'Y',
        dateOfCreation: new Date(),
      });
      await this.userMasterRepository.save(userMaster);

      // Populate userrights from userleveldefaultrights for this user level
      const defaultRights = await this.userMasterRepository.query(
        `SELECT menuid FROM userleveldefaultrights WHERE userlevelid = $1`,
        [userLevel.userlevelid]
      );
      if (defaultRights.length > 0) {
        const values = defaultRights.map((r: any) => `(${savedUser.id}, ${r.menuid})`).join(',');
        await this.userMasterRepository.query(
          `INSERT INTO userrights (userid, menuid) VALUES ${values} ON CONFLICT DO NOTHING`
        );
      }
    } catch (err) {
      this.logger.error(`Failed to sync legacy UserMaster: ${err.message}`);
    }

    return this.mapUserToResponseDto(savedUser);
  }

  private getLegacyLevelId(role: UserRole): number {
    switch (role) {
      case UserRole.SYSTEM: return 0;
      case UserRole.ADMIN: return 1;
      case UserRole.BRANCH_MANAGER: return 2;
      case UserRole.OFFICER: return 3;
      case UserRole.PASSING_OFFICER: return 4;
      case UserRole.AUDITOR: return 6;
      case UserRole.CASHIER: return 7;
      case UserRole.USER: return 8;
      default: return 1;
    }
  }

  async findAllUsers(
    page: number = 1,
    limit: number = 10,
    role?: UserRole,
    isActive?: boolean,
  ): Promise<{
    users: UserResponseDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const p = Number(page) || 1;
    const l = Number(limit) || 10;

    const options: FindManyOptions<User> = {
      skip: (p - 1) * l,
      take: l,
      order: { createdAt: 'DESC' },
    };

    const where: any = {};
    if (role) where.role = role;
    if (isActive !== undefined) where.isActive = isActive;

    if (Object.keys(where).length > 0) {
      options.where = where;
    }

    const [users, total] = await this.userRepository.findAndCount(options);

    return {
      users: users.map(user => this.mapUserToResponseDto(user)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findUserById(id: number): Promise<UserResponseDto> {
    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.mapUserToResponseDto(user);
  }

  async updateUser(id: number, updateUserDto: UpdateUserDto): Promise<UserResponseDto> {
    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if email is being updated and already exists
    if (updateUserDto.email && updateUserDto.email !== user.email) {
      const existingEmail = await this.userRepository.findOne({
        where: { email: updateUserDto.email },
      });

      if (existingEmail) {
        throw new ConflictException('Email already exists');
      }
    }

    // Check if username is being updated and already exists
    if (updateUserDto.username && updateUserDto.username !== user.username) {
      const existingUsername = await this.userRepository.findOne({
        where: { username: updateUserDto.username },
      });

      if (existingUsername) {
        throw new ConflictException('Username already exists');
      }
    }

    // If role is being updated, set default permissions for new role
    if (updateUserDto.role && updateUserDto.role !== user.role) {
      if (!updateUserDto.permissions) {
        updateUserDto.permissions = this.getDefaultPermissions(updateUserDto.role);
      }
    }

    Object.assign(user, updateUserDto);
    const updatedUser = await this.userRepository.save(user);

    // SYNCHRONIZATION: Update legacy UserMaster table
    try {
      const userMaster = await this.userMasterRepository.findOne({
        where: { userid: id }
      });

      if (userMaster) {
        if (updateUserDto.username) userMaster.susername = updateUserDto.username;
        if (updateUserDto.password) userMaster.spassword = updateUserDto.password;
        if (updateUserDto.isActive !== undefined) {
          userMaster.enableDisable = updateUserDto.isActive ? 'E' : 'D';
        }
        if (updateUserDto.role) {
          const userLevel = await this.userLevelMasterRepository.findOne({
            where: { userlevel: updateUserDto.role }
          });
          if (userLevel) {
            userMaster.userlevelid = userLevel.userlevelid;
          }
        }
        await this.userMasterRepository.save(userMaster);
      }
    } catch (err) {
      this.logger.error(`Failed to sync legacy UserMaster update: ${err.message}`);
    }

    return this.mapUserToResponseDto(updatedUser);
  }

  async deleteUser(id: number): Promise<{ message: string }> {
    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Prevent deletion of the last admin user
    if (user.role === UserRole.ADMIN) {
      const adminCount = await this.userRepository.count({
        where: { role: UserRole.ADMIN, isActive: true },
      });

      if (adminCount <= 1) {
        throw new ForbiddenException('Cannot delete the last admin user');
      }
    }

    await this.userRepository.remove(user);

    // SYNCHRONIZATION: Remove from legacy table
    try {
      const userMaster = await this.userMasterRepository.findOne({
        where: { userid: id }
      });
      if (userMaster) {
        await this.userMasterRepository.remove(userMaster);
      }
    } catch (err) {
      this.logger.error(`Failed to sync legacy UserMaster deletion: ${err.message}`);
    }

    return { message: 'User deleted successfully' };
  }

  async changeUserPassword(
    userId: number,
    changePasswordDto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Verify current password
    const isCurrentPasswordValid = await user.validatePassword(changePasswordDto.currentPassword);
    if (!isCurrentPasswordValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    // Update password
    user.password = changePasswordDto.newPassword;
    await this.userRepository.save(user);

    return { message: 'Password changed successfully' };
  }

  async adminChangeUserPassword(
    userId: number,
    adminChangePasswordDto: AdminChangePasswordDto,
  ): Promise<{ message: string }> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Update password
    user.password = adminChangePasswordDto.newPassword;
    await this.userRepository.save(user);

    return { message: 'Password changed successfully' };
  }

  async updateUserRole(
    userId: number,
    updateUserRoleDto: UpdateUserRoleDto,
  ): Promise<UserResponseDto> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Prevent changing role of the last admin user
    if (user.role === UserRole.ADMIN && updateUserRoleDto.role !== UserRole.ADMIN) {
      const adminCount = await this.userRepository.count({
        where: { role: UserRole.ADMIN, isActive: true },
      });

      if (adminCount <= 1) {
        throw new ForbiddenException('Cannot change role of the last admin user');
      }
    }

    user.role = updateUserRoleDto.role;
    user.permissions = updateUserRoleDto.permissions || this.getDefaultPermissions(updateUserRoleDto.role);

    const updatedUser = await this.userRepository.save(user);
    return this.mapUserToResponseDto(updatedUser);
  }

  async logUserActivity(
    userId: number,
    activityDto: UserActivityDto,
  ): Promise<UserActivityResponseDto> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const activity = this.userActivityRepository.create({
      userId,
      ...activityDto,
    });

    const savedActivity = await this.userActivityRepository.save(activity);

    return {
      ...savedActivity,
      user: {
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
      },
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
      relations: ['user'],
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return {
      activities: activities.map(activity => ({
        ...activity,
        user: activity.user ? {
          id: activity.user.id,
          username: activity.user.username,
          firstName: activity.user.firstName,
          lastName: activity.user.lastName,
        } : undefined,
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
      relations: ['user'],
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return {
      activities: activities.map(activity => ({
        ...activity,
        user: activity.user ? {
          id: activity.user.id,
          username: activity.user.username,
          firstName: activity.user.firstName,
          lastName: activity.user.lastName,
        } : undefined,
      })),
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

  private mapUserToResponseDto(user: User): UserResponseDto {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: user.fullName,
      role: user.role,
      permissions: user.permissions || [],
      isActive: user.isActive,
      avatar: user.avatar || null,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
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

    // Update login status
    userMaster.loginStatus = 'N';
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

  /**
   * Login/logout history for a user, newest first.
   *
   * The modern `users` table and the legacy `usermaster`/`logintime` tables are
   * separate. Login events are recorded against usermaster.userid, so we bridge
   * from the modern user id via username, falling back to treating the id as a
   * legacy userid directly.
   */
  async getUserLoginHistory(id: number, page = 1, limit = 20) {
    let userid: number | undefined;
    let username: string | undefined;

    const modernUser = await this.userRepository.findOne({ where: { id } });
    if (modernUser) {
      username = modernUser.username;
      const userMaster = await this.userMasterRepository.findOne({
        where: { susername: ILike(modernUser.username) },
      });
      userid = userMaster?.userid;
    }

    // Fallback: the caller may have passed a legacy usermaster.userid.
    if (userid === undefined) {
      const userMaster = await this.userMasterRepository.findOne({ where: { userid: id } });
      if (userMaster) {
        userid = userMaster.userid;
        username = username || userMaster.susername;
      }
    }

    if (userid === undefined) {
      throw new NotFoundException(`No login records found for user id ${id}`);
    }

    const [rows, total] = await this.loginTimeRepository.findAndCount({
      where: { userid },
      order: { loginDate: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      userId: id,
      username,
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
