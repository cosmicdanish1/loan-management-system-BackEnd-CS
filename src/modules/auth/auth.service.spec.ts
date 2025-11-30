import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UnauthorizedException, ConflictException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { User, UserRole, UserPermission } from './entities/user.entity';
import { LoginDto, RegisterDto } from './dto';

describe('AuthService', () => {
  let service: AuthService;
  let userRepository: Repository<User>;
  let jwtService: JwtService;
  let configService: ConfigService;

  const mockUser: Partial<User> = {
    id: 1,
    username: 'testuser',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    role: UserRole.DATA_OPERATOR,
    permissions: [UserPermission.READ_MEMBER],
    isActive: true,
    validatePassword: jest.fn(),
    hasPermission: jest.fn(),
    fullName: 'Test User',
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
      providers: [
        AuthService,
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

    service = module.get<AuthService>(AuthService);
    userRepository = module.get<Repository<User>>(getRepositoryToken(User));
    jwtService = module.get<JwtService>(JwtService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('validateUser', () => {
    it('should return user when credentials are valid', async () => {
      const user = { ...mockUser, validatePassword: jest.fn().mockResolvedValue(true) } as User;
      mockUserRepository.findOne.mockResolvedValue(user);

      const result = await service.validateUser('testuser', 'password');

      expect(result).toEqual(user);
      expect(mockUserRepository.findOne).toHaveBeenCalledWith({
        where: [
          { username: 'testuser', isActive: true },
          { email: 'testuser', isActive: true },
        ],
      });
    });

    it('should return null when user not found', async () => {
      mockUserRepository.findOne.mockResolvedValue(null);

      const result = await service.validateUser('nonexistent', 'password');

      expect(result).toBeNull();
    });

    it('should return null when password is invalid', async () => {
      const user = { ...mockUser, validatePassword: jest.fn().mockResolvedValue(false) } as User;
      mockUserRepository.findOne.mockResolvedValue(user);

      const result = await service.validateUser('testuser', 'wrongpassword');

      expect(result).toBeNull();
    });
  });

  describe('login', () => {
    const loginDto: LoginDto = {
      username: 'testuser',
      password: 'password',
    };

    it('should return auth response when credentials are valid', async () => {
      const user = { ...mockUser, validatePassword: jest.fn().mockResolvedValue(true) } as User;
      mockUserRepository.findOne.mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);
      mockConfigService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'JWT_SECRET':
            return 'test-secret';
          case 'JWT_REFRESH_SECRET':
            return 'test-refresh-secret';
          case 'JWT_EXPIRES_IN':
            return 3600;
          case 'JWT_REFRESH_EXPIRES_IN':
            return 604800;
          default:
            return undefined;
        }
      });
      mockJwtService.signAsync.mockResolvedValue('mock-token');

      const result = await service.login(loginDto);

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('user');
      expect(result.user.username).toBe('testuser');
    });

    it('should throw UnauthorizedException when credentials are invalid', async () => {
      jest.spyOn(service, 'validateUser').mockResolvedValue(null);

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
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

    it('should create new user successfully', async () => {
      mockUserRepository.findOne.mockResolvedValue(null); // No existing user
      const newUser = { ...mockUser, ...registerDto } as User;
      mockUserRepository.create.mockReturnValue(newUser);
      mockUserRepository.save.mockResolvedValue(newUser);
      mockConfigService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'JWT_SECRET':
            return 'test-secret';
          case 'JWT_REFRESH_SECRET':
            return 'test-refresh-secret';
          case 'JWT_EXPIRES_IN':
            return 3600;
          case 'JWT_REFRESH_EXPIRES_IN':
            return 604800;
          default:
            return undefined;
        }
      });
      mockJwtService.signAsync.mockResolvedValue('mock-token');

      const result = await service.register(registerDto);

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('user');
      expect(mockUserRepository.create).toHaveBeenCalled();
      expect(mockUserRepository.save).toHaveBeenCalled();
    });

    it('should throw ConflictException when username already exists', async () => {
      mockUserRepository.findOne.mockResolvedValueOnce(mockUser); // Username exists

      await expect(service.register(registerDto)).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException when email already exists', async () => {
      mockUserRepository.findOne
        .mockResolvedValueOnce(null) // Username doesn't exist
        .mockResolvedValueOnce(mockUser); // Email exists

      await expect(service.register(registerDto)).rejects.toThrow(ConflictException);
    });
  });

  describe('refreshToken', () => {
    it('should return new tokens when refresh token is valid', async () => {
      const payload = { sub: 1, username: 'testuser' };
      mockJwtService.verify.mockReturnValue(payload);
      mockUserRepository.findOne.mockResolvedValue(mockUser);
      mockConfigService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'JWT_SECRET':
            return 'test-secret';
          case 'JWT_REFRESH_SECRET':
            return 'test-refresh-secret';
          case 'JWT_EXPIRES_IN':
            return 3600;
          case 'JWT_REFRESH_EXPIRES_IN':
            return 604800;
          default:
            return undefined;
        }
      });
      mockJwtService.signAsync.mockResolvedValue('new-token');

      const result = await service.refreshToken({ refreshToken: 'valid-refresh-token' });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
    });

    it('should throw UnauthorizedException when refresh token is invalid', async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      await expect(
        service.refreshToken({ refreshToken: 'invalid-token' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('logout', () => {
    it('should return success message', async () => {
      mockUserRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.logout(1);

      expect(result).toEqual({ message: 'Logout successful' });
    });
  });

  describe('getCurrentUser', () => {
    it('should return user response DTO', async () => {
      mockUserRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.getCurrentUser(1);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('username');
      expect(result).toHaveProperty('email');
    });

    it('should throw NotFoundException when user not found', async () => {
      mockUserRepository.findOne.mockResolvedValue(null);

      await expect(service.getCurrentUser(999)).rejects.toThrow();
    });
  });
});
