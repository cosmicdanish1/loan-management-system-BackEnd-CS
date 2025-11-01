import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RoleGuard } from './role.guard';
import { UserRole, UserPermission } from '../entities/user.entity';

describe('RoleGuard', () => {
  let guard: RoleGuard;
  let reflector: Reflector;

  const mockReflector = {
    getAllAndOverride: jest.fn(),
  };

  const mockExecutionContext = {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: jest.fn().mockReturnValue({
      getRequest: jest.fn(),
    }),
  } as unknown as ExecutionContext;

  const mockUser = {
    id: 1,
    username: 'testuser',
    role: UserRole.LOAN_OFFICER,
    permissions: [UserPermission.READ_MEMBER, UserPermission.CREATE_MEMBER],
    hasPermission: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoleGuard,
        {
          provide: Reflector,
          useValue: mockReflector,
        },
      ],
    }).compile();

    guard = module.get<RoleGuard>(RoleGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('should allow access when no roles or permissions are required', () => {
    mockReflector.getAllAndOverride.mockReturnValue(undefined);
    const mockRequest = { user: mockUser };
    (mockExecutionContext.switchToHttp().getRequest as jest.Mock).mockReturnValue(mockRequest);

    const result = guard.canActivate(mockExecutionContext);

    expect(result).toBe(true);
  });

  it('should throw ForbiddenException when user is not authenticated', () => {
    mockReflector.getAllAndOverride
      .mockReturnValueOnce([UserRole.ADMIN]) // Required roles
      .mockReturnValueOnce(undefined); // No required permissions
    const mockRequest = { user: null };
    (mockExecutionContext.switchToHttp().getRequest as jest.Mock).mockReturnValue(mockRequest);

    expect(() => guard.canActivate(mockExecutionContext)).toThrow(ForbiddenException);
  });

  it('should allow access when user has required role', () => {
    mockReflector.getAllAndOverride
      .mockReturnValueOnce([UserRole.LOAN_OFFICER]) // Required roles
      .mockReturnValueOnce(undefined); // No required permissions
    const mockRequest = { user: mockUser };
    (mockExecutionContext.switchToHttp().getRequest as jest.Mock).mockReturnValue(mockRequest);

    const result = guard.canActivate(mockExecutionContext);

    expect(result).toBe(true);
  });

  it('should throw ForbiddenException when user does not have required role', () => {
    mockReflector.getAllAndOverride
      .mockReturnValueOnce([UserRole.ADMIN]) // Required roles
      .mockReturnValueOnce(undefined); // No required permissions
    const mockRequest = { user: mockUser };
    (mockExecutionContext.switchToHttp().getRequest as jest.Mock).mockReturnValue(mockRequest);

    expect(() => guard.canActivate(mockExecutionContext)).toThrow(ForbiddenException);
  });

  it('should allow access when user has required permission', () => {
    mockUser.hasPermission.mockReturnValue(true);
    mockReflector.getAllAndOverride
      .mockReturnValueOnce(undefined) // No required roles
      .mockReturnValueOnce([UserPermission.READ_MEMBER]); // Required permissions
    const mockRequest = { user: mockUser };
    (mockExecutionContext.switchToHttp().getRequest as jest.Mock).mockReturnValue(mockRequest);

    const result = guard.canActivate(mockExecutionContext);

    expect(result).toBe(true);
    expect(mockUser.hasPermission).toHaveBeenCalledWith(UserPermission.READ_MEMBER);
  });

  it('should throw ForbiddenException when user does not have required permission', () => {
    mockUser.hasPermission.mockReturnValue(false);
    mockReflector.getAllAndOverride
      .mockReturnValueOnce(undefined) // No required roles
      .mockReturnValueOnce([UserPermission.MANAGE_USERS]); // Required permissions
    const mockRequest = { user: mockUser };
    (mockExecutionContext.switchToHttp().getRequest as jest.Mock).mockReturnValue(mockRequest);

    expect(() => guard.canActivate(mockExecutionContext)).toThrow(ForbiddenException);
  });

  it('should allow access when user has both required role and permission', () => {
    mockUser.hasPermission.mockReturnValue(true);
    mockReflector.getAllAndOverride
      .mockReturnValueOnce([UserRole.LOAN_OFFICER]) // Required roles
      .mockReturnValueOnce([UserPermission.READ_MEMBER]); // Required permissions
    const mockRequest = { user: mockUser };
    (mockExecutionContext.switchToHttp().getRequest as jest.Mock).mockReturnValue(mockRequest);

    const result = guard.canActivate(mockExecutionContext);

    expect(result).toBe(true);
  });
});
