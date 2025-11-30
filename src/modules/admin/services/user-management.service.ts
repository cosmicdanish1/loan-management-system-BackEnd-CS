import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindManyOptions } from 'typeorm';
import { User, UserRole, UserPermission } from '../../auth/entities/user.entity';
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
export class UserManagementService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserActivity)
    private userActivityRepository: Repository<UserActivity>,
  ) {}

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

    // Create new user
    const user = this.userRepository.create({
      ...createUserDto,
      permissions,
    });

    const savedUser = await this.userRepository.save(user);
    return this.mapUserToResponseDto(savedUser);
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
    const options: FindManyOptions<User> = {
      skip: (page - 1) * limit,
      take: limit,
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

    // If role is being updated, set default permissions for new role
    if (updateUserDto.role && updateUserDto.role !== user.role) {
      if (!updateUserDto.permissions) {
        updateUserDto.permissions = this.getDefaultPermissions(updateUserDto.role);
      }
    }

    Object.assign(user, updateUserDto);
    const updatedUser = await this.userRepository.save(user);

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
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }

  private getDefaultPermissions(role: UserRole): UserPermission[] {
    switch (role) {
      case UserRole.ADMIN:
        return Object.values(UserPermission);
      
      case UserRole.MANAGER:
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
      
      case UserRole.LOAN_OFFICER:
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
      
      case UserRole.ACCOUNTANT:
        return [
          UserPermission.READ_MEMBER,
          UserPermission.READ_LOAN,
          UserPermission.READ_DEPOSIT,
          UserPermission.CREATE_TRANSACTION,
          UserPermission.READ_TRANSACTION,
          UserPermission.UPDATE_TRANSACTION,
          UserPermission.GENERATE_REPORTS,
          UserPermission.VIEW_FINANCIAL_REPORTS,
        ];
      
      case UserRole.DATA_OPERATOR:
      default:
        return [
          UserPermission.READ_MEMBER,
          UserPermission.READ_LOAN,
          UserPermission.READ_DEPOSIT,
          UserPermission.READ_TRANSACTION,
        ];
    }
  }
}
