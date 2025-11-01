import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User, UserRole, UserPermission } from './entities/user.entity';
import { LoginDto, RegisterDto, AuthResponseDto } from './dto';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: AuthService;

  const mockUser: Partial<User> = {
    id: 1,
    username: 'testuser',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    role: UserRole.DATA_OPERATOR,
    permissions: [UserPermission.READ_MEMBER],
    isActive: true,
    fullName: 'Test User',
  };

  const mockAuthResponse: AuthResponseDto = {
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    tokenType: 'Bearer',
    expiresIn: 3600,
    user: {
      id: 1,
      username: 'testuser',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      fullName: 'Test User',
      role: UserRole.DATA_OPERATOR,
      permissions: [UserPermission.READ_MEMBER],
      isActive: true,
      lastLoginAt: new Date(),
      createdAt: new Date(),
    },
  };

  const mockAuthService = {
    login: jest.fn(),
    register: jest.fn(),
    refreshToken: jest.fn(),
    logout: jest.fn(),
    getCurrentUser: jest.fn(),
  };

  const mockUserRepository = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockJwtService = {
    signAsync: jest.fn(),
    verify: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: mockAuthService,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
        {
          provide: JwtService,
          useValue: mockJwtService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('login', () => {
    const loginDto: LoginDto = {
      username: 'testuser',
      password: 'password',
    };

    it('should return auth response on successful login', async () => {
      mockAuthService.login.mockResolvedValue(mockAuthResponse);
      const mockRequest = { user: mockUser };

      const result = await controller.login(loginDto, mockRequest);

      expect(result).toEqual(mockAuthResponse);
      expect(mockAuthService.login).toHaveBeenCalledWith(loginDto);
    });
  });

  describe('register', () => {
    const registerDto: RegisterDto = {
      username: 'newuser',
      email: 'new@example.com',
      password: 'password123',
      firstName: 'New',
      lastName: 'User',
    };

    it('should return auth response on successful registration', async () => {
      mockAuthService.register.mockResolvedValue(mockAuthResponse);

      const result = await controller.register(registerDto);

      expect(result).toEqual(mockAuthResponse);
      expect(mockAuthService.register).toHaveBeenCalledWith(registerDto);
    });
  });

  describe('refreshToken', () => {
    const tokenRefreshDto = {
      refreshToken: 'valid-refresh-token',
    };

    it('should return new auth response on successful token refresh', async () => {
      mockAuthService.refreshToken.mockResolvedValue(mockAuthResponse);

      const result = await controller.refreshToken(tokenRefreshDto);

      expect(result).toEqual(mockAuthResponse);
      expect(mockAuthService.refreshToken).toHaveBeenCalledWith(tokenRefreshDto);
    });
  });

  describe('logout', () => {
    it('should return success message on logout', async () => {
      const mockRequest = { user: mockUser };
      const logoutResponse = { message: 'Logout successful' };
      mockAuthService.logout.mockResolvedValue(logoutResponse);

      const result = await controller.logout(mockUser as User);

      expect(result).toEqual(logoutResponse);
      expect(mockAuthService.logout).toHaveBeenCalledWith(mockUser.id);
    });
  });

  describe('getCurrentUser', () => {
    it('should return current user profile', async () => {
      const userResponse = mockAuthResponse.user;
      mockAuthService.getCurrentUser.mockResolvedValue(userResponse);

      const result = await controller.getCurrentUser(mockUser as User);

      expect(result).toEqual(userResponse);
      expect(mockAuthService.getCurrentUser).toHaveBeenCalledWith(mockUser.id);
    });
  });
});
