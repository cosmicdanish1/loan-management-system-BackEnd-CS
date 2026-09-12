import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { User, UserRole, UserPermission } from '../entities/user.entity';
import { UserMaster } from '../entities/user-master.entity';

export interface JwtPayload {
  sub: number;
  username: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserMaster)
    private userMasterRepository: Repository<UserMaster>,
    private configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<User> {
    const { sub: userId } = payload;

    // 1. Try UserMaster (new system)
    const userMaster = await this.userMasterRepository.findOne({
      where: { userid: userId },
      relations: ['userLevel'],
    });

    if (userMaster) {
      if (userMaster.enableDisable !== 'E') {
        throw new UnauthorizedException('User account is disabled');
      }

      const user = new User();
      user.id = userMaster.userid;
      user.username = userMaster.susername;
      user.email = `${userMaster.susername}@example.com`;
      user.firstName = userMaster.susername;
      user.lastName = '';
      user.role = userMaster.userLevel?.userlevel as any || UserRole.DATA_OPERATOR;

      // Map permissions based on role
      const permissions = [UserPermission.READ_MEMBER];
      if (user.role === UserRole.ADMIN || user.role === UserRole.DATA_OPERATOR || (user.role as any) === 'admin' || (user.role as any) === 'sample_1') {
        permissions.push(UserPermission.MANAGE_USERS);
      }
      user.permissions = permissions;
      user.isActive = userMaster.isEnabled;

      return user;
    }

    // 2. Fallback to User (old system)
    const user = await this.userRepository.findOne({
      where: { id: userId, isActive: true },
    });

    if (!user) {
      throw new UnauthorizedException('User not found or inactive');
    }

    // Update last login time (only for old users)
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    return user;
  }
}
