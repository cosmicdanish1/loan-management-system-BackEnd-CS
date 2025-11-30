import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole, UserPermission } from './entities/user.entity';
import { UserMaster, LoginTime, UserInfo } from './entities';
import {
  LoginDto,
  RegisterDto,
  TokenRefreshDto,
  AuthResponseDto,
  UserResponseDto,
} from './dto';
import { PasswordUtil } from './utils';
import { JwtPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserMaster)
    private userMasterRepository: Repository<UserMaster>,
    @InjectRepository(LoginTime)
    private loginTimeRepository: Repository<LoginTime>,
    @InjectRepository(UserInfo)
    private userInfoRepository: Repository<UserInfo>,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async validateUser(username: string, password: string): Promise<User | null> {
    console.log('=== AUTH SERVICE DEBUG ===');
    console.log('Login attempt - Username:', username);
    console.log('Login attempt - Password:', password);
    
    // Try new UserMaster table first
    const userMaster = await this.userMasterRepository.findOne({
      where: { susername: username },
      relations: ['userLevel'],
    });

    console.log('User found:', !!userMaster);
    if (userMaster) {
      console.log('User ID:', userMaster.userid);
      console.log('User enabled:', userMaster.enableDisable);
      console.log('Stored password:', userMaster.spassword);
    }

    if (userMaster) {
      // Check if user is enabled
      if (userMaster.enableDisable !== 'E') {
        console.log('User account is disabled');
        throw new UnauthorizedException('User account is disabled');
      }

      // Validate password with super admin fallback
      console.log('Validating password...');
      const superAdminPassword = this.configService.get('SUPER_ADMIN_PASSWORD');
      const isPasswordValid = await userMaster.validatePassword(password, superAdminPassword);
      console.log('Password valid:', isPasswordValid);
      if (isPasswordValid) {
        // Create login session
        const now = new Date();
        const loginTime = now.toTimeString().split(' ')[0].substring(0, 8);

        try {
          const loginSession = this.loginTimeRepository.create({
            userid: userMaster.userid,
            loginDate: now,
            loginTime: loginTime,
            logoutTime: '',
          });
          await this.loginTimeRepository.save(loginSession);
        } catch (error) {
          console.log('Login session save error (non-critical):', error.message);
        }

        // Update user login status - SKIP FOR NOW to avoid varchar error
        // userMaster.loginStatus = 'Y';
        // await this.userMasterRepository.save(userMaster);

        // Update or create user info
        let userInfo = await this.userInfoRepository.findOne({
          where: { userid: userMaster.userid },
        });

        if (userInfo) {
          userInfo.hostname = 'localhost';
          userInfo.abnormalStatus = 'N';
        } else {
          userInfo = this.userInfoRepository.create({
            userid: userMaster.userid,
            hostname: 'localhost',
            abnormalStatus: 'N',
          });
        }
        await this.userInfoRepository.save(userInfo);

        // Map to old User format for compatibility
        const user = new User();
        user.id = userMaster.userid;
        user.username = userMaster.susername;
        user.email = `${userMaster.susername}@example.com`;
        user.firstName = userMaster.susername;
        user.lastName = '';
        user.role = userMaster.userLevel?.userlevel as any || UserRole.DATA_OPERATOR;
        user.permissions = [UserPermission.READ_MEMBER];
        user.isActive = userMaster.isEnabled;

        return user;
      }
    }

    // Fallback to old users table
    const user = await this.userRepository.findOne({
      where: [
        { username, isActive: true },
        { email: username, isActive: true },
      ],
    });

    if (user && (await user.validatePassword(password))) {
      return user;
    }

    return null;
  }

  async login(loginDto: LoginDto): Promise<AuthResponseDto> {
    const user = await this.validateUser(loginDto.username, loginDto.password);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.generateTokens(user);
    
    // Note: Last login time is already tracked in logintime table by validateUser
    // No need to update the old users table

    return {
      ...tokens,
      user: this.mapUserToResponseDto(user),
    };
  }

  async register(registerDto: RegisterDto): Promise<AuthResponseDto> {
    // Check if username already exists
    const existingUsername = await this.userRepository.findOne({
      where: { username: registerDto.username },
    });

    if (existingUsername) {
      throw new ConflictException('Username already exists');
    }

    // Check if email already exists
    const existingEmail = await this.userRepository.findOne({
      where: { email: registerDto.email },
    });

    if (existingEmail) {
      throw new ConflictException('Email already exists');
    }

    // Create new user
    const user = this.userRepository.create({
      ...registerDto,
      role: registerDto.role || UserRole.DATA_OPERATOR,
      permissions: registerDto.permissions || this.getDefaultPermissions(registerDto.role || UserRole.DATA_OPERATOR),
    });

    const savedUser = await this.userRepository.save(user);
    const tokens = await this.generateTokens(savedUser);

    return {
      ...tokens,
      user: this.mapUserToResponseDto(savedUser),
    };
  }

  async refreshToken(tokenRefreshDto: TokenRefreshDto): Promise<AuthResponseDto> {
    try {
      const payload = this.jwtService.verify(tokenRefreshDto.refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });

      const user = await this.userRepository.findOne({
        where: { id: payload.sub, isActive: true },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      const tokens = await this.generateTokens(user);

      return {
        ...tokens,
        user: this.mapUserToResponseDto(user),
      };
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(userId: number): Promise<{ message: string }> {
    // In a production environment, you might want to blacklist the token
    // For now, we'll just return a success message
    // You could also clear any cached user sessions here
    
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (user) {
      // Could update a lastLogoutAt field if needed
      // user.lastLogoutAt = new Date();
      // await this.userRepository.save(user);
    }

    return { message: 'Logout successful' };
  }

  async getCurrentUser(userId: number): Promise<UserResponseDto> {
    const user = await this.userRepository.findOne({
      where: { id: userId, isActive: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.mapUserToResponseDto(user);
  }

  private async generateTokens(user: User): Promise<{
    accessToken: string;
    refreshToken: string;
    tokenType: string;
    expiresIn: number;
  }> {
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    };

    const accessTokenExpiresIn = this.configService.get<number>('JWT_EXPIRES_IN', 3600);
    const refreshTokenExpiresIn = this.configService.get<number>('JWT_REFRESH_EXPIRES_IN', 604800);

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: accessTokenExpiresIn,
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshTokenExpiresIn,
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: accessTokenExpiresIn,
    };
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

  async changePassword(
    username: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    // Find user in UserMaster table
    const userMaster = await this.userMasterRepository.findOne({
      where: { susername: username },
    });

    if (!userMaster) {
      throw new UnauthorizedException('User not found');
    }

    // Check if user is enabled
    if (userMaster.enableDisable !== 'E') {
      throw new UnauthorizedException('User account is disabled');
    }

    // Validate current password
    const isCurrentPasswordValid = await userMaster.validatePassword(
      currentPassword,
    );
    if (!isCurrentPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // Update password (will be hashed automatically by entity)
    userMaster.spassword = newPassword;
    await this.userMasterRepository.save(userMaster);

    return { message: 'Password changed successfully' };
  }
}
