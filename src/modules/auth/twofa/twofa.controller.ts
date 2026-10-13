import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Max, Min, IsArray } from 'class-validator';
import { Public, CurrentUser, Roles } from '../decorators';
import { RoleGuard } from '../guards';
import { User, UserRole } from '../entities/user.entity';
import { AuthService } from '../auth.service';
import { TwoFaService } from './twofa.service';
import type { TwoFaSettings, GuardConfig } from './twofa.service';
import { GUARD_ACTIONS } from './twofa.service';

class ChallengeDto {
  @IsString() @MaxLength(2000) challengeToken: string;
}
class VerifyDto extends ChallengeDto {
  @IsString() @MaxLength(40) code: string;
  @IsOptional() @IsBoolean() rememberDevice?: boolean;
}
class ConfirmDto {
  @IsString() @MaxLength(40) code: string;
}
class LoginConfirmDto extends ChallengeDto {
  @IsString() @MaxLength(40) code: string;
}
class PasswordDto {
  @IsString() @MaxLength(200) password: string;
}
class DisableDto extends PasswordDto {
  @IsString() @MaxLength(40) code: string;
}
class GuardsDto {
  @IsObject() guards: Record<string, Partial<GuardConfig>>;
  @IsOptional() @IsString() @MaxLength(200) password?: string;
  @IsOptional() @IsString() @MaxLength(40) code?: string;
}
class ApproversDto {
  @IsOptional() @IsArray() @IsInt({ each: true }) add?: number[];
  @IsOptional() @IsArray() @IsInt({ each: true }) remove?: number[];
}
class SettingsDto {
  @IsOptional() @IsIn(['off', 'optional', 'roles', 'all']) policy?: TwoFaSettings['policy'];
  @IsOptional() @IsArray() @IsInt({ each: true }) requiredLevelIds?: number[];
  @IsOptional() @IsInt() @Min(0) @Max(365) graceDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) rememberDays?: number;
  @IsOptional() @IsInt() recoveryCount?: number;
  @IsOptional() @IsInt() maxAttempts?: number;
  @IsOptional() @IsInt() lockoutMinutes?: number;
  @IsOptional() @IsString() @MaxLength(40) issuer?: string;
  @IsOptional() @IsBoolean() approverCanApproveOwn?: boolean;
}

// Tight limit on every unauthenticated step of the login flow. Per-account
// lockout (in the service) is the real brake; this just slows blind spraying.
const LOGIN_STEP_LIMIT = { default: { limit: 20, ttl: 60_000 } };

@ApiTags('Two-factor authentication')
@Controller('auth/2fa')
export class TwoFaController {
  constructor(
    private readonly twofa: TwoFaService,
    private readonly auth: AuthService,
  ) {}

  // ------------------------------------------------ second step of login

  @Public()
  @Throttle(LOGIN_STEP_LIMIT)
  @Post('login/verify')
  @HttpCode(HttpStatus.OK)
  async loginVerify(@Body() dto: VerifyDto) {
    const userId = this.twofa.readChallenge(dto.challengeToken, 'verify');
    const kind = await this.twofa.verifyUserCode(userId, dto.code, true);
    const deviceToken = dto.rememberDevice && kind === 'totp' ? await this.twofa.trustDevice(userId) : null;
    const session = await this.auth.completeTwoFaLogin(userId);
    return { ...session, deviceToken, usedRecoveryCode: kind === 'recovery' };
  }

  @Public()
  @Throttle(LOGIN_STEP_LIMIT)
  @Post('login/enroll/begin')
  @HttpCode(HttpStatus.OK)
  async loginEnrollBegin(@Body() dto: ChallengeDto) {
    const userId = this.twofa.readChallenge(dto.challengeToken, 'enrol');
    return this.twofa.beginEnroll(userId, { skipPassword: true });
  }

  /** Confirms the first code, then finishes the login. The UI holds the session back until the recovery codes are acknowledged. */
  @Public()
  @Throttle(LOGIN_STEP_LIMIT)
  @Post('login/enroll/confirm')
  @HttpCode(HttpStatus.OK)
  async loginEnrollConfirm(@Body() dto: LoginConfirmDto) {
    const userId = this.twofa.readChallenge(dto.challengeToken, 'enrol');
    const { recoveryCodes } = await this.twofa.confirmEnroll(userId, dto.code);
    const session = await this.auth.completeTwoFaLogin(userId);
    return { ...session, recoveryCodes };
  }

  // ---------------------------------------------------- signed-in user

  @Get('status')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  status(@CurrentUser() user: User) {
    return this.twofa.status(user.id);
  }

  @Post('enroll/begin')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  enrollBegin(@CurrentUser() user: User, @Body() dto: PasswordDto) {
    return this.twofa.beginEnroll(user.id, { password: dto.password });
  }

  @Post('enroll/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  enrollConfirm(@CurrentUser() user: User, @Body() dto: ConfirmDto) {
    return this.twofa.confirmEnroll(user.id, dto.code);
  }

  @Post('disable')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async disable(@CurrentUser() user: User, @Body() dto: DisableDto) {
    await this.twofa.disable(user.id, dto.password, dto.code);
    return { message: 'Two-factor authentication turned off' };
  }

  @Post('recovery/regenerate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  async regenerate(@CurrentUser() user: User, @Body() dto: ConfirmDto) {
    return { recoveryCodes: await this.twofa.regenerateRecovery(user.id, dto.code) };
  }

  // ------------------------------------------------------- admin only

  @Get('settings')
  @UseGuards(AuthGuard('jwt'), RoleGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  async getSettings() {
    return { settings: await this.twofa.getSettings(), levels: await this.twofa.levels() };
  }

  @Put('settings')
  @UseGuards(AuthGuard('jwt'), RoleGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  async saveSettings(@CurrentUser() user: User, @Body() dto: SettingsDto) {
    return { settings: await this.twofa.saveSettings(dto, user.username) };
  }

  /** Per-window approver-code switches (ES-116) and the approver roster (ES-124). */
  @Get('guards')
  @UseGuards(AuthGuard('jwt'), RoleGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  async getGuards() {
    return {
      actions: Object.entries(GUARD_ACTIONS).map(([key, v]) => ({ key, ...v })),
      guards: await this.twofa.getGuards(),
      approvers: await this.twofa.listApprovers(),
    };
  }

  /** Switching a protection OFF needs password + an approver's code in the body; switching ON needs neither. */
  @Put('guards')
  @UseGuards(AuthGuard('jwt'), RoleGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  async saveGuards(@CurrentUser() user: User, @Body() body: GuardsDto) {
    return {
      guards: await this.twofa.saveGuards(body?.guards || {}, { id: user.id, username: user.username }, { password: body?.password, code: body?.code }),
      approvers: await this.twofa.listApprovers(),
    };
  }

  /** Grant / remove the Approver (OTP) right (same right as in the Access Privilege Matrix). */
  @Put('approvers')
  @UseGuards(AuthGuard('jwt'), RoleGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  async setApprovers(@CurrentUser() user: User, @Body() body: ApproversDto) {
    return { approvers: await this.twofa.setApprovers(body?.add || [], body?.remove || [], { id: user.id, username: user.username }) };
  }

  @Get('admin/users')
  @UseGuards(AuthGuard('jwt'), RoleGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  adminUsers() {
    return this.twofa.adminList();
  }

  @Post('admin/reset/:userid')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'), RoleGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  async adminReset(@CurrentUser() user: User, @Param('userid', ParseIntPipe) userid: number) {
    await this.twofa.adminReset(userid, user.username);
    return { message: 'Two-factor authentication reset. The user must set it up again.' };
  }

  @Post('admin/unlock/:userid')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'), RoleGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  async adminUnlock(@CurrentUser() user: User, @Param('userid', ParseIntPipe) userid: number) {
    await this.twofa.clearLock(userid, user.username);
    return { message: 'Lockout cleared' };
  }
}
