import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthService } from '../auth.service';
import { User } from '../entities/user.entity';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    super({
      usernameField: 'username', // Can be username or email
    });
  }

  async validate(username: string, password: string): Promise<User> {
    // ES-296: the password check happens here (before AuthService.login), so the lockout must too
    this.authService.assertNotLocked(username);
    const user = await this.authService.validateUser(username, password);

    if (!user) {
      this.authService.noteLoginFailure(username);
      throw new UnauthorizedException('Invalid credentials');
    }

    return user;
  }
}
