import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { User, UserRole, UserPermission } from './entities/user.entity';
import { UserMaster, UserLevelMaster, LoginTime, UserInfo, UserRights, UserLevelDefaultRights } from './entities';
import {
  LoginDto,
  RegisterDto,
  TokenRefreshDto,
  AuthResponseDto,
  UserResponseDto,
} from './dto';
import { PasswordUtil, mapUserMasterToUser } from './utils';
import { JwtPayload } from './strategies/jwt.strategy';
import { MENUID_TO_ACTION, BYPASS_USER_LEVEL_IDS } from './menu-action-map';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(UserMaster)
    private userMasterRepository: Repository<UserMaster>,
    @InjectRepository(UserLevelMaster)
    private userLevelMasterRepository: Repository<UserLevelMaster>,
    @InjectRepository(LoginTime)
    private loginTimeRepository: Repository<LoginTime>,
    @InjectRepository(UserInfo)
    private userInfoRepository: Repository<UserInfo>,
    @InjectRepository(UserRights)
    private userRightsRepository: Repository<UserRights>,
    @InjectRepository(UserLevelDefaultRights)
    private defaultRightsRepository: Repository<UserLevelDefaultRights>,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) { }

  /**
   * Which Navbar `action` codes this user level is allowed to see, driven by
   * Configure UserLevel Default Rights (userleveldefaultrights) plus any
   * per-user overrides (userrights). Returns null for SYSTEM/ADMINISTRATOR,
   * meaning "no restriction" — matches the existing master-bypass pattern in
   * RoleGuard/PermissionsGuard for those roles. This is what makes the Role
   * Management screen's saved rights actually take effect: previously nothing
   * in the app ever read menuid -> action, so they had no observable effect.
   */
  async getAllowedActions(userid: number, userlevelid: number): Promise<string[] | null> {
    if (BYPASS_USER_LEVEL_IDS.has(userlevelid)) {
      return null;
    }

    const [userRights, defaultRights] = await Promise.all([
      this.userRightsRepository.find({ where: { userid } }),
      this.defaultRightsRepository.find({ where: { userlevelid } }),
    ]);

    const menuIds = new Set<number>([
      ...userRights.map((r) => r.menuid),
      ...defaultRights.map((r) => r.menuid),
    ]);

    const actions = new Set<string>();
    for (const menuid of menuIds) {
      const action = MENUID_TO_ACTION.get(menuid);
      if (action) actions.add(action);
    }
    return Array.from(actions);
  }

  async validateUser(username: string, password: string): Promise<User | null> {
    // BUG FIX 2: Never log credentials — removed all plaintext/hash console.log calls

    // Try new UserMaster table first
    const userMaster = await this.userMasterRepository.findOne({
      where: { susername: username },
      relations: ['userLevel'],
    });

    if (userMaster) {
      // Check if user is enabled
      if (userMaster.enableDisable !== 'E') {
        this.logger.log('User account is disabled');
        throw new UnauthorizedException('User account is disabled');
      }

      // Validate password with super admin fallback
      const superAdminPassword = this.configService.get('SUPER_ADMIN_PASSWORD');
      const isPasswordValid = await userMaster.validatePassword(password, superAdminPassword);
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
          this.logger.warn(`Login session save error (non-critical): ${error.message}`);
        }

        // BUG FIX: this was skipped ("to avoid varchar error"), but that error came
        // from susername/spassword being too narrow for modern usernames/hashes —
        // already fixed by repairDatabaseSchema() widening both columns on boot.
        // Leaving loginStatus permanently 'N' meant getActiveSessions() (the "Peek
        // Active" list in LogoutUser) could never show a currently logged-in user —
        // only ever stale 'Y' rows left over from before this was disabled.
        try {
          userMaster.loginStatus = 'Y';
          await this.userMasterRepository.save(userMaster);
        } catch (error) {
          this.logger.warn(`Login status update error (non-critical): ${error.message}`);
        }

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

        // Map to the User shape used app-wide by guards/strategies
        const user = mapUserMasterToUser(userMaster);
        user.allowedActions = await this.getAllowedActions(userMaster.userid, userMaster.userlevelid);
        return user;
      }
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
      user: { ...this.mapUserToResponseDto(user), allowedActions: user.allowedActions ?? null },
    };
  }

  async register(registerDto: RegisterDto): Promise<AuthResponseDto> {
    // BUG FIX: this used to write only to the modern `users` table — but
    // validateUser() checks usermaster first, so a self-registered account
    // could never actually log in through the real path. usermaster is the
    // single source of truth now; write there directly.
    const existingUsername = await this.userMasterRepository.findOne({
      where: { susername: registerDto.username },
    });
    if (existingUsername) {
      throw new ConflictException('Username already exists');
    }

    if (registerDto.email) {
      const existingEmail = await this.userMasterRepository.findOne({
        where: { email: registerDto.email },
      });
      if (existingEmail) {
        throw new ConflictException('Email already exists');
      }
    }

    const role = registerDto.role || UserRole.DATA_OPERATOR;
    const permissions = registerDto.permissions || this.getDefaultPermissions(role);

    const normalizedRole = role.replace(/_/g, ' ').toUpperCase();
    let userLevel = await this.userLevelMasterRepository
      .createQueryBuilder('ul')
      .where(`UPPER(REPLACE(ul.userlevel, '_', ' ')) = :role`, { role: normalizedRole })
      .getOne();
    if (!userLevel) {
      const existingLevels = await this.userLevelMasterRepository.find({ order: { userlevelid: 'DESC' }, take: 1 });
      const nextLevelId = existingLevels.length > 0 ? existingLevels[0].userlevelid + 1 : 0;
      userLevel = this.userLevelMasterRepository.create({ userlevelid: nextLevelId, userlevel: role });
      await this.userLevelMasterRepository.save(userLevel);
    }

    const lastUser = await this.userMasterRepository.find({ order: { userid: 'DESC' } as any, take: 1 });
    const nextId = lastUser.length > 0 ? lastUser[0].userid + 1 : 1;

    const userMaster = this.userMasterRepository.create({
      userid: nextId,
      susername: registerDto.username,
      spassword: registerDto.password,
      userlevelid: userLevel.userlevelid,
      userLevel,
      enableDisable: 'E',
      loginStatus: 'N',
      passTransactionFlag: 'Y',
      dateOfCreation: new Date(),
      email: registerDto.email,
      firstName: registerDto.firstName,
      lastName: registerDto.lastName,
      permissions,
    });
    const saved = await this.userMasterRepository.save(userMaster);

    const user = mapUserMasterToUser(saved);
    const tokens = await this.generateTokens(user);

    return {
      ...tokens,
      user: this.mapUserToResponseDto(user),
    };
  }

  async refreshToken(tokenRefreshDto: TokenRefreshDto): Promise<AuthResponseDto> {
    try {
      const payload = this.jwtService.verify(tokenRefreshDto.refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });

      this.logger.debug('Refresh token payload received');

      const userMaster = await this.userMasterRepository.findOne({
        where: { userid: payload.sub },
        relations: ['userLevel'],
      });

      let user: User | null = null;

      if (userMaster) {
        if (userMaster.enableDisable !== 'E') {
          throw new UnauthorizedException('User account is disabled');
        }
        // Same forceLogoutAt check as JwtStrategy — without this, a session
        // an admin just force-logged-out could silently mint itself a brand
        // new access token via its still-valid refresh token, undoing the
        // force logout entirely.
        if (userMaster.forceLogoutAt && payload.iat) {
          const issuedAtMs = payload.iat * 1000;
          if (issuedAtMs < userMaster.forceLogoutAt.getTime()) {
            throw new UnauthorizedException('Session was terminated by an administrator');
          }
        }
        user = mapUserMasterToUser(userMaster);
      }

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      const tokens = await this.generateTokens(user);

      return {
        ...tokens,
        user: this.mapUserToResponseDto(user),
      };
    } catch (error) {
      this.logger.error(`Refresh token error: ${error.message}`);
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  // C-1 fix: logout used to only flip audit rows (below) — the JWT itself kept
  // working until its natural 24h expiry, so "logging out" on a shared machine
  // did nothing. Sessions are genuinely concurrent (logintime has multiple open
  // rows per user), so revocation must be per-token, not a single account-wide
  // flag — a denylist keyed by the token's own hash, scoped to just the token
  // that called /auth/logout, leaves other devices/tabs logged in.
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private async ensureRevokedTokensTable(): Promise<void> {
    await this.userMasterRepository.query(`
      CREATE TABLE IF NOT EXISTS revoked_tokens (
        token_hash  VARCHAR(64) PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        revoked_at  TIMESTAMP DEFAULT NOW(),
        expires_at  TIMESTAMP NOT NULL
      )
    `);
    // Opportunistic cleanup — a revoked token is only worth keeping until it
    // would have expired naturally anyway.
    await this.userMasterRepository.query(
      `DELETE FROM revoked_tokens WHERE expires_at < NOW()`,
    );
  }

  async logout(userId: number, rawToken?: string): Promise<{ message: string }> {
    // BUG FIX 5: Actually close the logintime session and reset loginStatus
    // for UserMaster (new auth system) users.

    // 1. Find and close the open logintime session (logoutTime = '' means active)
    const activeSession = await this.loginTimeRepository.findOne({
      where: { userid: userId, logoutTime: '' },
      order: { loginDate: 'DESC' },
    });

    if (activeSession) {
      const now = new Date();
      activeSession.logoutTime = now.toTimeString().split(' ')[0].substring(0, 8); // HH:MM:SS
      await this.loginTimeRepository.save(activeSession);
    }

    // 2. Reset loginStatus in usermaster so the user no longer appears "logged in"
    const userMaster = await this.userMasterRepository.findOne({
      where: { userid: userId },
    });
    if (userMaster) {
      userMaster.loginStatus = 'N';
      await this.userMasterRepository.save(userMaster);
    }

    // 3. Revoke the actual token so it stops working immediately instead of
    // riding out its natural expiry.
    if (rawToken) {
      const decoded = this.jwtService.decode(rawToken) as JwtPayload | null;
      const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 24 * 60 * 60 * 1000);
      await this.ensureRevokedTokensTable();
      await this.userMasterRepository.query(
        `INSERT INTO revoked_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (token_hash) DO NOTHING`,
        [this.hashToken(rawToken), userId, expiresAt],
      );
    }

    return { message: 'Logout successful' };
  }

  async getCurrentUser(userId: number): Promise<UserResponseDto> {
    // BUG FIX: this only ever read the modern `users` table, which 404'd for
    // every real usermaster-authenticated user fetching their own profile.
    const userMaster = await this.userMasterRepository.findOne({
      where: { userid: userId },
    });

    if (!userMaster || !userMaster.isEnabled) {
      throw new NotFoundException('User not found');
    }

    return this.mapUserToResponseDto(mapUserMasterToUser(userMaster));
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
      avatar: user.avatar || null,
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

  async getUsersList(): Promise<any> {
    const users = await this.userMasterRepository.find({
      select: ['userid', 'susername', 'userlevelid', 'enableDisable'],
      order: { susername: 'ASC' },
    });
    return users.map(u => ({
      userid: u.userid,
      susername: u.susername,
      userlevelid: u.userlevelid,
      enable_disable: u.enableDisable,
    }));
  }

  async getUsernames(): Promise<any> {
    const users = await this.userMasterRepository.find({
      select: ['userid', 'susername'],
      where: { enableDisable: 'E' },
      order: { susername: 'ASC' },
    });
    return users.map(u => ({ userid: u.userid, susername: u.susername }));
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
