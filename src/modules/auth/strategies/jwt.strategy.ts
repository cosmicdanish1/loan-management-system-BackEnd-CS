import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { User } from '../entities/user.entity';
import { UserMaster } from '../entities/user-master.entity';
import { mapUserMasterToUser } from '../utils';

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

    const userMaster = await this.userMasterRepository.findOne({
      where: { userid: userId },
      relations: ['userLevel'],
    });

    if (!userMaster) {
      throw new UnauthorizedException('User not found or inactive');
    }

    if (userMaster.enableDisable !== 'E') {
      throw new UnauthorizedException('User account is disabled');
    }

    // BUG FIX: this used to duplicate mapUserMasterToUser's logic inline, and
    // had drifted — missing the MANAGE_SYSTEM_CONFIG/DAY_END_OPERATIONS/
    // PERFORM_BACKUP grants the other copy had. Since this function (not the
    // one in auth.service.ts) governs req.user on every authenticated
    // request, that meant every admin request potentially missed those
    // permissions, not just login. Now a single shared function.
    return mapUserMasterToUser(userMaster);
  }
}
