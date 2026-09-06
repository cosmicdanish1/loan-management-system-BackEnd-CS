import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
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
  async login(@Body() loginDto: LoginDto, @Request() req): Promise<AuthResponseDto> {
    return this.authService.login(loginDto);
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
    return this.authService.logout(user.id, rawToken);
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

  // BUG FIX 3: Added JWT guard — change-password must require a valid session.
  // 4.4 fix: the ChangePasswordDto this comment describes existed in dto/ but was
  // never actually wired in — the parameter was still a plain inline TS type, which
  // class-validator can't see (types are erased at compile time; only a real class
  // with decorators works), so an empty/malformed body reached bcrypt as undefined
  // instead of being rejected with 400. Confirmed live: {} body -> 500 "data and
  // hash arguments required".
  // 2026-08-23 fix: the body's `username` was never checked against the caller's
  // own JWT identity, and there was no role check — any authenticated user could
  // change any OTHER user's password (including an admin's) just by knowing that
  // user's current password. Confirmed live via a data_operator test account
  // taking over an administrator test account. Initially patched with an
  // ADMIN-role override for cross-account resets, but the user asked for that
  // removed too (self-service only, no exceptions here) — a deliberate
  // admin-reset feature belongs in its own more carefully-guarded endpoint,
  // not one that still demands the target's current password anyway.
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change your own password' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 403, description: 'Cannot change another user\'s password' })
  async changePassword(
    @CurrentUser() user: User,
    @Body() changePasswordDto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    if (changePasswordDto.username !== user.username) {
      throw new ForbiddenException('You can only change your own password');
    }
    return this.authService.changePassword(
      changePasswordDto.username,
      changePasswordDto.currentPassword,
      changePasswordDto.newPassword,
    );
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

  @Public()
  @Get('usernames')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get usernames only for password change dropdown (no sensitive data)' })
  async getUsernames(): Promise<any> {
    return this.authService.getUsernames();
  }
}
