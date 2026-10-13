import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TwoFaService } from './twofa.service';

export const REQUIRE_AUTH_CODE_KEY = 'requireAuthCode';

/** A fixed action key, or a function that picks the key(s) from the request (e.g. by voucher type). */
export type AuthCodeAction = string | ((req: any, twofa: TwoFaService) => Promise<string | null> | string | null);

/**
 * Marks an endpoint as protected by the performer's own authenticator code (ES-116).
 * Whether it is actually enforced is a per-action switch in Administration > Security >
 * Two-Factor Authentication; with the switch OFF the endpoint behaves exactly as before.
 * The code travels in the `X-Auth-Code` header.
 */
export const RequireAuthCode = (...actions: AuthCodeAction[]) => SetMetadata(REQUIRE_AUTH_CODE_KEY, actions);

@Injectable()
export class AuthCodeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly twofa: TwoFaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const specs = this.reflector.get<AuthCodeAction[] | undefined>(REQUIRE_AUTH_CODE_KEY, context.getHandler());
    if (!specs || specs.length === 0) return true;
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) return true; // not signed in: the JWT guard has already decided

    const actions: string[] = [];
    for (const s of specs) {
      const a = typeof s === 'function' ? await s(req, this.twofa) : s;
      if (a) actions.push(a);
    }
    const target = Object.values(req.params || {}).join('/');
    await this.twofa.enforceActions(actions, { id: user.id, username: user.username }, req.headers['x-auth-code'] as string | undefined, target);
    return true;
  }
}
