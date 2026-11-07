import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators';
import { MobileAuditInterceptor } from '../audit/mobile-audit.interceptor';
import { CurrentMember, MemberJwtGuard } from '../auth/member-jwt.guard';
import { CurrentMemberInfo } from '../auth/member-jwt.strategy';
import { MobileThrottlerGuard } from '../security/mobile-throttler.guard';
import { clientCtx } from './access.types';
import { ActivateCompleteDto, ActivateDto, ActivationRequestDto, LoginDto, LogoutDto, RefreshDto, StepUpDto } from './access.dto';
import { ActivationService } from './activation.service';
import { AppCodeService } from './app-code.service';
import { MemberAuthService } from './member-auth.service';

/** Strict per-IP limits on the routes an attacker would hammer (the default for /mobile is 300 per minute). */
const STRICT = { default: { limit: 20, ttl: 60_000 } };

/** Member sign-in routes (PRD section 10). @Public() only switches off the STAFF guard. */
@ApiTags('Mobile auth')
@Public()
@UseGuards(MobileThrottlerGuard)
@UseInterceptors(MobileAuditInterceptor)
@Controller('mobile/auth')
export class MobileAuthController {
  constructor(
    private readonly activation: ActivationService,
    private readonly auth: MemberAuthService,
    private readonly appCode: AppCodeService,
  ) {}

  @Post('activation-request')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Ask the society to activate my app (staff will call back)' })
  activationRequest(@Body() dto: ActivationRequestDto, @Req() req: any) {
    return this.activation.submitRequest(dto, clientCtx(req, dto.deviceId));
  }

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT)
  @ApiOperation({ summary: 'Step 1 of activation: member number + staff activation code' })
  activate(@Body() dto: ActivateDto, @Req() req: any) {
    return this.activation.activate(dto, clientCtx(req, dto.deviceId));
  }

  @Post('activate/complete')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT)
  @ApiOperation({ summary: 'Step 2 of activation: set MPIN, accept Terms, bind this phone' })
  complete(@Body() dto: ActivateCompleteDto, @Req() req: any) {
    return this.activation.complete(dto, clientCtx(req, dto.deviceId));
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT)
  @ApiOperation({ summary: 'Sign in with member number + MPIN' })
  login(@Body() dto: LoginDto, @Req() req: any) {
    return this.auth.login(dto, clientCtx(req, dto.deviceId));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Exchange a refresh token for a new pair (the old one stops working)' })
  refresh(@Body() dto: RefreshDto, @Req() req: any) {
    return this.auth.refresh(dto, clientCtx(req, dto.deviceId));
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(MemberJwtGuard)
  @ApiOperation({ summary: 'Sign out this phone' })
  async logout(@Body() dto: LogoutDto, @CurrentMember() member: CurrentMemberInfo, @Req() req: any) {
    await this.auth.logout(dto, member, clientCtx(req, dto.deviceId));
    return { signedOut: true };
  }

  @Post('step-up')
  @HttpCode(HttpStatus.OK)
  @UseGuards(MemberJwtGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Check the App Code and get a 2-minute approval for one sensitive action' })
  stepUp(@Body() dto: StepUpDto, @CurrentMember() member: CurrentMemberInfo, @Req() req: any) {
    return this.appCode.stepUp(member, dto.action, dto.code, clientCtx(req));
  }
}
