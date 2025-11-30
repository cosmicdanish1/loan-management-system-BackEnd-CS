import {
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import {
  Public,
  CurrentUser,
  Roles,
  RequirePermissions,
} from '../decorators';
import { RoleGuard, PermissionsGuard } from '../guards';
import { UserRole, UserPermission, User } from '../entities/user.entity';

@ApiTags('Authentication Examples')
@Controller('auth-examples')
export class AuthExamplesController {
  @Public()
  @Get('public')
  @ApiOperation({ summary: 'Public endpoint - no authentication required' })
  @ApiResponse({ status: 200, description: 'Public access granted' })
  getPublicData() {
    return { message: 'This is a public endpoint' };
  }

  @Get('authenticated')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Authenticated endpoint - requires valid JWT' })
  @ApiResponse({ status: 200, description: 'Authenticated access granted' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getAuthenticatedData(@CurrentUser() user: User) {
    return {
      message: 'This endpoint requires authentication',
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    };
  }

  @Get('admin-only')
  @Roles(UserRole.ADMIN)
  @UseGuards(AuthGuard('jwt'), RoleGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin only endpoint' })
  @ApiResponse({ status: 200, description: 'Admin access granted' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  getAdminData(@CurrentUser() user: User) {
    return {
      message: 'This endpoint is for admins only',
      user: user.username,
    };
  }

  @Get('manager-or-admin')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @UseGuards(AuthGuard('jwt'), RoleGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Manager or Admin endpoint' })
  @ApiResponse({ status: 200, description: 'Manager/Admin access granted' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  getManagerData(@CurrentUser() user: User) {
    return {
      message: 'This endpoint is for managers and admins',
      user: user.username,
      role: user.role,
    };
  }

  @Get('create-member-permission')
  @RequirePermissions(UserPermission.CREATE_MEMBER)
  @UseGuards(AuthGuard('jwt'), PermissionsGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Requires CREATE_MEMBER permission' })
  @ApiResponse({ status: 200, description: 'Permission granted' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  getCreateMemberData(@CurrentUser() user: User) {
    return {
      message: 'This endpoint requires CREATE_MEMBER permission',
      user: user.username,
      permissions: user.permissions,
    };
  }

  @Post('multiple-permissions')
  @RequirePermissions(
    UserPermission.CREATE_LOAN,
    UserPermission.APPROVE_LOAN,
  )
  @UseGuards(AuthGuard('jwt'), PermissionsGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Requires multiple permissions (any one)' })
  @ApiResponse({ status: 200, description: 'Permission granted' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  createLoanData(@CurrentUser() user: User) {
    return {
      message: 'This endpoint requires CREATE_LOAN or APPROVE_LOAN permission',
      user: user.username,
      permissions: user.permissions,
    };
  }

  @Get('combined-role-permission')
  @Roles(UserRole.LOAN_OFFICER, UserRole.MANAGER)
  @RequirePermissions(UserPermission.READ_MEMBER)
  @UseGuards(AuthGuard('jwt'), RoleGuard, PermissionsGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Requires specific role AND permission' })
  @ApiResponse({ status: 200, description: 'Access granted' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  getCombinedData(@CurrentUser() user: User) {
    return {
      message: 'This endpoint requires specific role AND permission',
      user: user.username,
      role: user.role,
      permissions: user.permissions,
    };
  }
}
