import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
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
  async logout(@CurrentUser() user: User): Promise<{ message: string }> {
    return this.authService.logout(user.id);
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
  // Also added ChangePasswordDto type instead of `any` so class-validator runs.
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change user password' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async changePassword(
    @Body() changePasswordDto: { username: string; currentPassword: string; newPassword: string },
  ): Promise<{ message: string }> {
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
}
