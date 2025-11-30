import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { UserManagementService } from './user-management.service';
import { User, UserRole, UserPermission } from '../../auth/entities/user.entity';
import { UserActivity } from '../entities/user-activity.entity';

describe('UserManagementService', () => {
  let service: UserManagementService;
  let userRepository: Repository<User>;
  let userActivityRepository: Repository<UserActivity>;

  const mockUserRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
  };

  const mockUserActivityRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserManagementService,
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
        {
          provide: getRepositoryToken(UserActivity),
          useValue: mockUserActivityRepository,
        },
      ],
    }).compile();

    service = module.get<UserManagementService>(UserManagementService);
    userRepository = module.get<Repository<User>>(getRepositoryToken(User));
    userActivityRepository = module.get<Repository<UserActivity>>(
      getRepositoryToken(UserActivity),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createUser', () => {
    it('should create a new user successfully', async () => {
      const createUserDto = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
        firstName: 'Test',
        lastName: 'User',
        role: UserRole.DATA_OPERATOR,
      };

      const mockUser = {
        id: 1,
        ...createUserDto,
        fullName: 'Test User',
        permissions: [UserPermission.READ_MEMBER],
        isActive: true,
        createdAt: new Date(),
      };

      mockUserRepository.findOne
        .mockResolvedValueOnce(null) // Username check
        .mockResolvedValueOnce(null); // Email check
      mockUserRepository.create.mockReturnValue(mockUser);
      mockUserRepository.save.mockResolvedValue(mockUser);

      const result = await service.createUser(createUserDto);

      expect(mockUserRepository.findOne).toHaveBeenCalledTimes(2);
      expect(mockUserRepository.create).toHaveBeenCalledWith({
        ...createUserDto,
        permissions: expect.any(Array),
      });
      expect(result.username).toBe(createUserDto.username);
      expect(result.email).toBe(createUserDto.email);
    });

    it('should throw ConflictException if username already exists', async () => {
      const createUserDto = {
        username: 'existinguser',
        email: 'test@example.com',
        password: 'password123',
        firstName: 'Test',
        lastName: 'User',
        role: UserRole.DATA_OPERATOR,
      };

      mockUserRepository.findOne.mockResolvedValue({ id: 1 }); // Existing user

      await expect(service.createUser(createUserDto)).rejects.toThrow(
        ConflictException,
      );
      expect(mockUserRepository.findOne).toHaveBeenCalledWith({
        where: { username: createUserDto.username },
      });
    });

    it('should throw ConflictException if email already exists', async () => {
      const createUserDto = {
        username: 'testuser',
        email: 'existing@example.com',
        password: 'password123',
        firstName: 'Test',
        lastName: 'User',
        role: UserRole.DATA_OPERATOR,
      };

      mockUserRepository.findOne
        .mockResolvedValueOnce(null) // Username check passes
        .mockResolvedValueOnce({ id: 1 }); // Email check fails

      await expect(service.createUser(createUserDto)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('findAllUsers', () => {
    it('should return paginated users', async () => {
      const mockUsers = [
        {
          id: 1,
          username: 'user1',
          email: 'user1@example.com',
          firstName: 'User',
          lastName: 'One',
          fullName: 'User One',
          role: UserRole.DATA_OPERATOR,
          permissions: [],
          isActive: true,
          createdAt: new Date(),
        },
        {
          id: 2,
          username: 'user2',
          email: 'user2@example.com',
          firstName: 'User',
          lastName: 'Two',
          fullName: 'User Two',
          role: UserRole.LOAN_OFFICER,
          permissions: [],
          isActive: true,
          createdAt: new Date(),
        },
      ];

      mockUserRepository.findAndCount.mockResolvedValue([mockUsers, 2]);

      const result = await service.findAllUsers(1, 10);

      expect(mockUserRepository.findAndCount).toHaveBeenCalledWith({
        skip: 0,
        take: 10,
        order: { createdAt: 'DESC' },
      });
      expect(result.users).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it('should filter users by role and active status', async () => {
      const mockUsers = [
        {
          id: 1,
          username: 'admin',
          role: UserRole.ADMIN,
          isActive: true,
          fullName: 'Admin User',
          permissions: [],
          createdAt: new Date(),
        },
      ];

      mockUserRepository.findAndCount.mockResolvedValue([mockUsers, 1]);

      const result = await service.findAllUsers(1, 10, UserRole.ADMIN, true);

      expect(mockUserRepository.findAndCount).toHaveBeenCalledWith({
        skip: 0,
        take: 10,
        order: { createdAt: 'DESC' },
        where: { role: UserRole.ADMIN, isActive: true },
      });
      expect(result.users).toHaveLength(1);
    });
  });

  describe('updateUser', () => {
    it('should update user successfully', async () => {
      const mockUser = {
        id: 1,
        username: 'testuser',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        role: UserRole.DATA_OPERATOR,
        fullName: 'Test Updated',
        permissions: [],
        isActive: true,
        createdAt: new Date(),
      };

      const updateDto = {
        firstName: 'Updated',
        lastName: 'User',
      };

      mockUserRepository.findOne.mockResolvedValue(mockUser);
      mockUserRepository.save.mockResolvedValue({
        ...mockUser,
        ...updateDto,
        fullName: 'Updated User',
      });

      const result = await service.updateUser(1, updateDto);

      expect(mockUserRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
      });
      expect(mockUserRepository.save).toHaveBeenCalled();
      expect(result.firstName).toBe('Updated');
    });

    it('should throw NotFoundException if user not found', async () => {
      mockUserRepository.findOne.mockResolvedValue(null);

      await expect(service.updateUser(999, { firstName: 'Updated' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ConflictException if email already exists', async () => {
      const mockUser = {
        id: 1,
        email: 'current@example.com',
      };

      const updateDto = {
        email: 'existing@example.com',
      };

      mockUserRepository.findOne
        .mockResolvedValueOnce(mockUser) // User exists
        .mockResolvedValueOnce({ id: 2 }); // Email already exists

      await expect(service.updateUser(1, updateDto)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('deleteUser', () => {
    it('should delete user successfully', async () => {
      const mockUser = {
        id: 1,
        role: UserRole.DATA_OPERATOR,
      };

      mockUserRepository.findOne.mockResolvedValue(mockUser);
      mockUserRepository.remove.mockResolvedValue(mockUser);

      const result = await service.deleteUser(1);

      expect(mockUserRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
      });
      expect(mockUserRepository.remove).toHaveBeenCalledWith(mockUser);
      expect(result.message).toBe('User deleted successfully');
    });

    it('should throw ForbiddenException when deleting last admin', async () => {
      const mockUser = {
        id: 1,
        role: UserRole.ADMIN,
      };

      mockUserRepository.findOne.mockResolvedValue(mockUser);
      mockUserRepository.count.mockResolvedValue(1); // Only one admin

      await expect(service.deleteUser(1)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('changeUserPassword', () => {
    it('should change password successfully', async () => {
      const mockUser = {
        id: 1,
        validatePassword: jest.fn().mockResolvedValue(true),
        password: 'oldpassword',
      };

      const changePasswordDto = {
        currentPassword: 'oldpassword',
        newPassword: 'newpassword123',
      };

      mockUserRepository.findOne.mockResolvedValue(mockUser);
      mockUserRepository.save.mockResolvedValue({
        ...mockUser,
        password: 'newpassword123',
      });

      const result = await service.changeUserPassword(1, changePasswordDto);

      expect(mockUser.validatePassword).toHaveBeenCalledWith('oldpassword');
      expect(mockUserRepository.save).toHaveBeenCalled();
      expect(result.message).toBe('Password changed successfully');
    });

    it('should throw BadRequestException for incorrect current password', async () => {
      const mockUser = {
        id: 1,
        validatePassword: jest.fn().mockResolvedValue(false),
      };

      const changePasswordDto = {
        currentPassword: 'wrongpassword',
        newPassword: 'newpassword123',
      };

      mockUserRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.changeUserPassword(1, changePasswordDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('logUserActivity', () => {
    it('should log user activity successfully', async () => {
      const mockUser = {
        id: 1,
        username: 'testuser',
        firstName: 'Test',
        lastName: 'User',
      };

      const activityDto = {
        activityType: 'LOGIN',
        description: 'User logged in',
        ipAddress: '192.168.1.1',
      };

      const mockActivity = {
        id: 1,
        userId: 1,
        ...activityDto,
        createdAt: new Date(),
      };

      mockUserRepository.findOne.mockResolvedValue(mockUser);
      mockUserActivityRepository.create.mockReturnValue(mockActivity);
      mockUserActivityRepository.save.mockResolvedValue(mockActivity);

      const result = await service.logUserActivity(1, activityDto);

      expect(mockUserRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
      });
      expect(mockUserActivityRepository.create).toHaveBeenCalledWith({
        userId: 1,
        ...activityDto,
      });
      expect(result.activityType).toBe('LOGIN');
      expect(result.user).toEqual({
        id: 1,
        username: 'testuser',
        firstName: 'Test',
        lastName: 'User',
      });
    });
  });

  describe('getUserActivities', () => {
    it('should return user activities with pagination', async () => {
      const mockActivities = [
        {
          id: 1,
          userId: 1,
          activityType: 'LOGIN',
          description: 'User logged in',
          createdAt: new Date(),
          user: {
            id: 1,
            username: 'testuser',
            firstName: 'Test',
            lastName: 'User',
          },
        },
      ];

      mockUserActivityRepository.findAndCount.mockResolvedValue([
        mockActivities,
        1,
      ]);

      const result = await service.getUserActivities(1, 1, 20);

      expect(mockUserActivityRepository.findAndCount).toHaveBeenCalledWith({
        where: { userId: 1 },
        relations: ['user'],
        skip: 0,
        take: 20,
        order: { createdAt: 'DESC' },
      });
      expect(result.activities).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('updateUserRole', () => {
    it('should update user role successfully', async () => {
      const mockUser = {
        id: 1,
        role: UserRole.DATA_OPERATOR,
        fullName: 'Test User',
        permissions: [],
        isActive: true,
        createdAt: new Date(),
      };

      const updateRoleDto = {
        role: UserRole.LOAN_OFFICER,
      };

      mockUserRepository.findOne.mockResolvedValue(mockUser);
      mockUserRepository.save.mockResolvedValue({
        ...mockUser,
        role: UserRole.LOAN_OFFICER,
        permissions: [UserPermission.CREATE_MEMBER, UserPermission.READ_MEMBER],
      });

      const result = await service.updateUserRole(1, updateRoleDto);

      expect(mockUserRepository.save).toHaveBeenCalled();
      expect(result.role).toBe(UserRole.LOAN_OFFICER);
    });

    it('should throw ForbiddenException when changing last admin role', async () => {
      const mockUser = {
        id: 1,
        role: UserRole.ADMIN,
      };

      const updateRoleDto = {
        role: UserRole.MANAGER,
      };

      mockUserRepository.findOne.mockResolvedValue(mockUser);
      mockUserRepository.count.mockResolvedValue(1); // Only one admin

      await expect(service.updateUserRole(1, updateRoleDto)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('getRolePermissions', () => {
    it('should return role permissions mapping', () => {
      const result = service.getRolePermissions();

      expect(result).toHaveLength(5); // 5 roles
      expect(result[0]).toHaveProperty('role');
      expect(result[0]).toHaveProperty('permissions');
      expect(Array.isArray(result[0].permissions)).toBe(true);
    });
  });
});
