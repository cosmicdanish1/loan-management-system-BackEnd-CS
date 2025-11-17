import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  UserMaster,
  UserLevelMaster,
  MenuMaster,
  UserRights,
  UserLevelDefaultRights,
  UserInfo,
  LoginTime,
} from './entities';

@Injectable()
export class AuthEnhancedService {
  constructor(
    @InjectRepository(UserMaster)
    private userMasterRepository: Repository<UserMaster>,
    @InjectRepository(UserLevelMaster)
    private userLevelRepository: Repository<UserLevelMaster>,
    @InjectRepository(MenuMaster)
    private menuRepository: Repository<MenuMaster>,
    @InjectRepository(UserRights)
    private userRightsRepository: Repository<UserRights>,
    @InjectRepository(UserLevelDefaultRights)
    private defaultRightsRepository: Repository<UserLevelDefaultRights>,
    @InjectRepository(UserInfo)
    private userInfoRepository: Repository<UserInfo>,
    @InjectRepository(LoginTime)
    private loginTimeRepository: Repository<LoginTime>,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  /**
   * Validate user credentials
   */
  async validateUser(
    username: string,
    password: string,
  ): Promise<UserMaster | null> {
    const user = await this.userMasterRepository.findOne({
      where: { susername: username },
      relations: ['userLevel'],
    });

    if (!user) {
      return null;
    }

    // Check if user is enabled
    if (user.enableDisable !== 'E') {
      throw new UnauthorizedException('User account is disabled');
    }

    // Validate password
    const isPasswordValid = await user.validatePassword(password);
    if (!isPasswordValid) {
      return null;
    }

    return user;
  }

  /**
   * Check if user has active session today
   */
  async checkActiveSession(userid: number): Promise<LoginTime | null> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const activeSession = await this.loginTimeRepository.findOne({
      where: {
        userid,
        logoutTime: '', // Empty logout time means active session
      },
      order: { loginDate: 'DESC' },
    });

    if (activeSession && activeSession.isToday()) {
      return activeSession;
    }

    return null;
  }

  /**
   * Login user with session management
   */
  async login(
    username: string,
    password: string,
    hostname?: string,
    forceLogin: boolean = false,
  ) {
    // Validate credentials
    const user = await this.validateUser(username, password);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check for active session today
    const activeSession = await this.checkActiveSession(user.userid);
    if (activeSession && !forceLogin) {
      throw new ConflictException({
        message: 'User already has an active session today',
        activeSession: {
          loginDate: activeSession.loginDate,
          loginTime: activeSession.loginTime,
        },
        requiresForceLogin: true,
      });
    }

    // If force login, logout previous session
    if (activeSession && forceLogin) {
      await this.logoutSession(activeSession);
    }

    // Get user permissions
    const permissions = await this.getUserPermissions(user.userid);

    // Create login session
    const now = new Date();
    const loginTime = now.toTimeString().split(' ')[0].substring(0, 8); // HH:MM:SS

    const loginSession = this.loginTimeRepository.create({
      userid: user.userid,
      loginDate: now,
      loginTime: loginTime,
      logoutTime: '',
    });
    await this.loginTimeRepository.save(loginSession);

    // Update user login status
    user.loginStatus = 'Y';
    await this.userMasterRepository.save(user);

    // Update or create user info
    await this.updateUserInfo(user.userid, hostname || 'unknown', 'N');

    // Generate JWT tokens
    const tokens = await this.generateTokens(user);

    return {
      ...tokens,
      user: {
        userid: user.userid,
        username: user.susername,
        userlevel: user.userLevel.userlevel,
        userlevelid: user.userlevelid,
        permissions: permissions,
        canPassTransactions: user.canPassTransactions,
      },
      session: {
        loginDate: loginSession.loginDate,
        loginTime: loginSession.loginTime,
      },
    };
  }

  /**
   * Logout user
   */
  async logout(userid: number) {
    // Find active session
    const activeSession = await this.loginTimeRepository.findOne({
      where: {
        userid,
        logoutTime: '',
      },
      order: { loginDate: 'DESC' },
    });

    if (activeSession) {
      await this.logoutSession(activeSession);
    }

    // Update user login status
    await this.userMasterRepository.update(
      { userid },
      { loginStatus: 'N' },
    );

    return { message: 'Logout successful' };
  }

  /**
   * Logout a specific session
   */
  private async logoutSession(session: LoginTime) {
    const now = new Date();
    const logoutTime = now.toTimeString().split(' ')[0].substring(0, 8);

    session.logoutTime = logoutTime;
    await this.loginTimeRepository.save(session);
  }

  /**
   * Get user permissions (user rights + default rights)
   */
  async getUserPermissions(userid: number): Promise<MenuMaster[]> {
    const user = await this.userMasterRepository.findOne({
      where: { userid },
      relations: ['userLevel'],
    });

    if (!user) {
      return [];
    }

    // Get user-specific rights
    const userRights = await this.userRightsRepository.find({
      where: { userid },
      relations: ['menu'],
    });

    // Get default rights for user level
    const defaultRights = await this.defaultRightsRepository.find({
      where: { userlevelid: user.userlevelid },
      relations: ['menu'],
    });

    // Combine and deduplicate menus
    const menuMap = new Map<number, MenuMaster>();

    userRights.forEach((right) => {
      if (right.menu && right.menu.isVisible) {
        menuMap.set(right.menu.menuid, right.menu);
      }
    });

    defaultRights.forEach((right) => {
      if (right.menu && right.menu.isVisible) {
        menuMap.set(right.menu.menuid, right.menu);
      }
    });

    return Array.from(menuMap.values());
  }

  /**
   * Update user info
   */
  private async updateUserInfo(
    userid: number,
    hostname: string,
    abnormalStatus: string,
  ) {
    let userInfo = await this.userInfoRepository.findOne({
      where: { userid },
    });

    if (userInfo) {
      userInfo.hostname = hostname;
      userInfo.abnormalStatus = abnormalStatus;
    } else {
      userInfo = this.userInfoRepository.create({
        userid,
        hostname,
        abnormalStatus,
      });
    }

    await this.userInfoRepository.save(userInfo);
  }

  /**
   * Generate JWT tokens
   */
  private async generateTokens(user: UserMaster) {
    const payload = {
      sub: user.userid,
      username: user.susername,
      userlevelid: user.userlevelid,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: this.configService.get<string>('JWT_EXPIRES_IN', '24h'),
    });

    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get<string>(
        'JWT_REFRESH_EXPIRES_IN',
        '7d',
      ),
    });

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.configService.get<string>('JWT_EXPIRES_IN', '24h'),
    };
  }

  /**
   * Get login history for a user
   */
  async getLoginHistory(userid: number, limit: number = 10) {
    return this.loginTimeRepository.find({
      where: { userid },
      order: { loginDate: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get active sessions
   */
  async getActiveSessions() {
    return this.loginTimeRepository.find({
      where: { logoutTime: '' },
      relations: ['user', 'user.userLevel'],
      order: { loginDate: 'DESC' },
    });
  }
}
