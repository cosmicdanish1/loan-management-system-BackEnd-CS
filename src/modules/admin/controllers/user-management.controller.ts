import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../../auth/guards/role.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole, UserPermission } from '../../auth/entities/user.entity';
import { UserResponseDto } from '../../auth/dto';
import { UserManagementService } from '../services/user-management.service';
import {
  CreateUserDto,
  UpdateUserDto,
  ChangePasswordDto,
  AdminChangePasswordDto,
  UserActivityDto,
  UserActivityResponseDto,
  RolePermissionsDto,
  UpdateUserRoleDto,
} from '../dto';

@ApiTags('User Management')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RoleGuard, PermissionsGuard)
@Controller('admin/users')
export class UserManagementController {
  constructor(private readonly userManagementService: UserManagementService) { }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.USER, UserRole.DATA_OPERATOR, 'sample_1' as any)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Create a new user' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'User created successfully',
    type: UserResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Username or email already exists',
  })
  async createUser(@Body() createUserDto: CreateUserDto): Promise<UserResponseDto> {
    return this.userManagementService.createUser(createUserDto);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.BRANCH_MANAGER, UserRole.USER, UserRole.DATA_OPERATOR, 'sample_1' as any)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Get all users with pagination and filtering' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  @ApiQuery({ name: 'role', required: false, enum: UserRole, description: 'Filter by role' })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean, description: 'Filter by active status' })
  @ApiQuery({ name: 'username', required: false, type: String, description: 'Filter by username (partial match)' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Users retrieved successfully',
  })
  // 5.4 fix: same DefaultValuePipe+ParseIntPipe fix as day-end/processes —
  // plain JS default parameters don't reliably apply to @Query() here.
  async findAllUsers(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('role') role?: UserRole,
    @Query('isActive') isActive?: boolean,
    @Query('username') username?: string,
  ) {
    return this.userManagementService.findAllUsers(page, limit, role, isActive, username);
  }

  @Get('roles/permissions')
  @Roles(UserRole.ADMIN, UserRole.BRANCH_MANAGER, 'sample_1' as any)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Get role permissions mapping' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Role permissions retrieved successfully',
    type: [RolePermissionsDto],
  })
  async getRolePermissions(): Promise<RolePermissionsDto[]> {
    return this.userManagementService.getRolePermissions();
  }

  @Get('activities')
  @Roles(UserRole.ADMIN, UserRole.BRANCH_MANAGER)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Get all user activities' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'User activities retrieved successfully',
  })
  // 5.4 fix: same DefaultValuePipe+ParseIntPipe fix as day-end/processes.
  async getAllUserActivities(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.userManagementService.getAllUserActivities(page, limit);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.BRANCH_MANAGER)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiParam({ name: 'id', type: Number, description: 'User ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'User retrieved successfully',
    type: UserResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'User not found',
  })
  async findUserById(@Param('id', ParseIntPipe) id: number): Promise<UserResponseDto> {
    return this.userManagementService.findUserById(id);
  }

  @Put(':id')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Update user information' })
  @ApiParam({ name: 'id', type: Number, description: 'User ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'User updated successfully',
    type: UserResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'User not found',
  })
  async updateUser(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateUserDto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    return this.userManagementService.updateUser(id, updateUserDto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Delete user' })
  @ApiParam({ name: 'id', type: Number, description: 'User ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'User deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'User not found',
  })
  async deleteUser(@Param('id', ParseIntPipe) id: number): Promise<{ message: string }> {
    return this.userManagementService.deleteUser(id);
  }

  @Put(':id/password')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Change user password (admin)' })
  @ApiParam({ name: 'id', type: Number, description: 'User ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Password changed successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'User not found',
  })
  async adminChangeUserPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() adminChangePasswordDto: AdminChangePasswordDto,
  ): Promise<{ message: string }> {
    return this.userManagementService.adminChangeUserPassword(id, adminChangePasswordDto);
  }

  @Put(':id/role')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Update user role and permissions' })
  @ApiParam({ name: 'id', type: Number, description: 'User ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'User role updated successfully',
    type: UserResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'User not found',
  })
  async updateUserRole(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateUserRoleDto: UpdateUserRoleDto,
  ): Promise<UserResponseDto> {
    return this.userManagementService.updateUserRole(id, updateUserRoleDto);
  }

  @Post(':id/activities')
  @Roles(UserRole.ADMIN, UserRole.BRANCH_MANAGER)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Log user activity' })
  @ApiParam({ name: 'id', type: Number, description: 'User ID' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Activity logged successfully',
    type: UserActivityResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'User not found',
  })
  async logUserActivity(
    @Param('id', ParseIntPipe) id: number,
    @Body() activityDto: UserActivityDto,
  ): Promise<UserActivityResponseDto> {
    return this.userManagementService.logUserActivity(id, activityDto);
  }

  @Get(':id/activities')
  @Roles(UserRole.ADMIN, UserRole.BRANCH_MANAGER)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Get user activities' })
  @ApiParam({ name: 'id', type: Number, description: 'User ID' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'User activities retrieved successfully',
  })
  // 5.4 fix: same DefaultValuePipe+ParseIntPipe fix as day-end/processes.
  async getUserActivities(
    @Param('id', ParseIntPipe) id: number,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.userManagementService.getUserActivities(id, page, limit);
  }

  @Get(':id/login-history')
  @Roles(UserRole.ADMIN, UserRole.BRANCH_MANAGER)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Get a user login/logout history (audit trail)' })
  @ApiParam({ name: 'id', type: Number, description: 'User ID' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Login history retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No login records found for user',
  })
  // 5.4 fix: same DefaultValuePipe+ParseIntPipe fix as day-end/processes.
  async getUserLoginHistory(
    @Param('id', ParseIntPipe) id: number,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.userManagementService.getUserLoginHistory(id, page, limit);
  }

  @Put('change-password')
  @ApiOperation({ summary: 'Change own password' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Password changed successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Current password is incorrect',
  })
  async changePassword(
    @CurrentUser() user: any,
    @Body() changePasswordDto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    return this.userManagementService.changeUserPassword(user.id, changePasswordDto);
  }

  @Post('active-sessions/terminate')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Force logout a user session (Admin)' })
  @ApiResponse({ status: 200, description: 'Session terminated' })
  // 4.4 fix: a missing username crashed with 500 "Cannot read properties of
  // undefined (reading 'trim')" inside the service — confirmed live.
  async forceLogout(@Body('username') username: string): Promise<{ message: string }> {
    if (!username) {
      throw new BadRequestException('username is required');
    }
    return this.userManagementService.forceLogoutUser(username);
  }

  @Get('active-sessions/matrix')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_USERS)
  @ApiOperation({ summary: 'Get all active user sessions' })
  @ApiResponse({ status: 200, description: 'Active sessions retrieved' })
  async getActiveSessions(): Promise<any[]> {
    return this.userManagementService.getActiveSessions();
  }
}
