import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import {
  LoginDto,
  RegisterDto,
  TokenRefreshDto,
  AuthResponseDto,
  UserResponseDto,
  ChangePasswordDto,
} from './dto';
import {
  Public, 
  CurrentUser, 
  Roles, 
  RequirePermissions 
} from './decorators';
import { RoleGuard } from './guards';
import { UserRole, UserPermission, User } from './entities/user.entity';
import { AlertBridge } from '../alerts/alert-bridge';
import { clientInfoOf } from '../alerts/client-info';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('local'))
  @ApiOperation({ summary: 'User login' })
  @ApiResponse({
    status: 200,
    description: 'Login successful',
    type: AuthResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() loginDto: LoginDto, @Request() req): Promise<AuthResponseDto | Record<string, any>> {
    const result: any = await this.authService.login(loginDto);
    // Password OK but a second step is pending: not a completed login yet.
    if (result?.requires2fa || result?.requires2faEnrol) return result;
    try {
      const u: any = (result as any)?.user;
      AlertBridge.get()?.loginOk({
        userId: u?.id ?? loginDto.username,
        username: u?.username ?? loginDto.username,
        role: u?.role,
        client: clientInfoOf(req),
      });
    } catch { /* alerting must never affect login */ }
    return result;
  }

  // BUG FIX 4: Removed @Public() — it conflicts with @UseGuards(AuthGuard('jwt'))
  // and causes the admin role check to be bypassed entirely.
  // Register is protected by JWT + admin role, same as any other guarded route.
  @Post('register')
  @UseGuards(AuthGuard('jwt'), RoleGuard)
  @Roles(UserRole.ADMIN) // Only admins can register new users
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Register new user (Admin only)' })
  @ApiResponse({
    status: 201,
    description: 'User registered successfully',
    type: AuthResponseDto,
  })
  @ApiResponse({ status: 409, description: 'Username or email already exists' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async register(@Body() registerDto: RegisterDto): Promise<AuthResponseDto> {
    return this.authService.register(registerDto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({
    status: 200,
    description: 'Token refreshed successfully',
    type: AuthResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refreshToken(@Body() tokenRefreshDto: TokenRefreshDto): Promise<AuthResponseDto> {
    return this.authService.refreshToken(tokenRefreshDto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'User logout' })
  @ApiResponse({ status: 200, description: 'Logout successful' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async logout(@CurrentUser() user: User, @Request() req): Promise<{ message: string }> {
    const rawToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const result = await this.authService.logout(user.id, rawToken);
    try {
      AlertBridge.get()?.logout({ userId: user.id, username: (user as any).username, client: clientInfoOf(req) });
    } catch { /* alerting must never affect logout */ }
    return result;
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: 200,
    description: 'Current user profile',
    type: UserResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getCurrentUser(@CurrentUser() user: User): Promise<UserResponseDto> {
    return this.authService.getCurrentUser(user.id);
  }

  /** Sent by the desktop app about once a minute while a user is signed in; powers "who is online". */
  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Presence signal from the app (who is online)' })
  heartbeat(@CurrentUser() user: User, @Request() req): { ok: boolean } {
    try {
      AlertBridge.get()?.heartbeat({
        userId: user.id,
        username: (user as any).username,
        role: (user as any).role,
        client: clientInfoOf(req),
      });
    } catch { /* presence must never break the app */ }
    return { ok: true };
  }

  // BUG FIX 3: Added JWT guard — change-password must require a valid session.
  // Also added ChangePasswordDto type instead of `any` so class-validator runs.
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change user password' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async changePassword(
    @CurrentUser() user: User,
    @Body() changePasswordDto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    // The target username used to come straight from the request body, so any
    // logged-in user could change ANOTHER user's password (including an
    // admin's) just by knowing that user's current password. Self-service only,
    // no exceptions (the user's explicit decision on 2026-08-23): a deliberate
    // admin-reset belongs in its own, more carefully guarded endpoint.
    if (String(changePasswordDto.username).toLowerCase() !== String(user.username).toLowerCase()) {
      throw new ForbiddenException('You can only change your own password');
    }
    // Password policy (min 8, upper, lower, digit) is enforced by ChangePasswordDto;
    // this additionally rejects "changing" to the same password.
    if (changePasswordDto.newPassword === changePasswordDto.currentPassword) {
      throw new BadRequestException('New password must be different from the current password');
    }
    const result = await this.authService.changePassword(
      changePasswordDto.username,
      changePasswordDto.currentPassword,
      changePasswordDto.newPassword,
    );
    try {
      AlertBridge.get()?.passwordChanged({ by: user.username, username: user.username, self: true });
    } catch { /* alerting must never affect a password change */ }
    return result;
  }

  // BUG FIX 6: Removed @Public() — username enumeration must require authentication.
  // The LogoutUser frontend calls this with a token from localStorage.
  @Get('users-list')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get list of all users for dropdown (authenticated admins only)' })
  async getUsersList(): Promise<any> {
    return this.authService.getUsersList();
  }

  // Authenticated (the original was @Public(), which let anyone enumerate usernames).
  @Get('usernames')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get usernames only (no sensitive data)' })
  async getUsernames(): Promise<any> {
    return this.authService.getUsernames();
  }
}
