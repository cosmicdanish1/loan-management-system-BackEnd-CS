import { ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { MEMBER_JWT_STRATEGY } from '../mobile.constants';
import { CurrentMemberInfo } from './member-jwt.strategy';

/**
 * Use on /mobile routes that need a signed-in member: @UseGuards(MemberJwtGuard).
 * The controller must also be @Public() so the global STAFF guard steps aside.
 */
@Injectable()
export class MemberJwtGuard extends AuthGuard(MEMBER_JWT_STRATEGY) {
  handleRequest<T = CurrentMemberInfo>(err: unknown, user: T): T {
    if (err || !user) throw new UnauthorizedException('Please sign in again');
    return user;
  }
}

/** @CurrentMember() member: CurrentMemberInfo  (never read a member number from the request body or URL). */
export const CurrentMember = createParamDecorator((_data: unknown, ctx: ExecutionContext): CurrentMemberInfo => {
  return ctx.switchToHttp().getRequest().user;
});
