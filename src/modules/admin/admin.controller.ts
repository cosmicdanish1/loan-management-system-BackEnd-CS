import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../auth/guards/role.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { UserRole, UserPermission } from '../auth/entities/user.entity';
import { AdminService } from './admin.service';
import { SystemConfigService } from './services/system-config.service';
import { CreateDepositSlabDto, UpdateDepositSlabDto, DepositSlabResponseDto } from './dto';

@ApiTags('Administration')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RoleGuard, PermissionsGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly systemConfigService: SystemConfigService
  ) { }

  @Get('dashboard')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Get admin dashboard data' })
  @ApiResponse({
    status: 200,
    description: 'Dashboard data retrieved successfully',
  })
  async getDashboard() {
    return this.adminService.getDashboardData();
  }

  @Get('system-info')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Get system information' })
  @ApiResponse({
    status: 200,
    description: 'System information retrieved successfully',
  })
  async getSystemInfo() {
    return this.adminService.getSystemInfo();
  }

  // Deposit Slab Management Endpoints
  @Get('deposit-loan-slabs')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Get all deposit/loan slabs' })
  @ApiResponse({
    status: 200,
    description: 'Deposit/loan slabs retrieved successfully',
    type: [DepositSlabResponseDto],
  })
  async getDepositLoanSlabs(@Query() query: any) {
    return this.systemConfigService.findAllDepositSlabs(query);
  }

  @Get('deposit-loan-slabs/:id')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Get deposit/loan slab by ID' })
  @ApiResponse({
    status: 200,
    description: 'Deposit/loan slab retrieved successfully',
    type: DepositSlabResponseDto,
  })
  async getDepositLoanSlab(@Param('id', ParseIntPipe) id: number) {
    return this.systemConfigService.findDepositSlabById(id);
  }

  @Post('deposit-loan-slabs')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Create new deposit/loan slab' })
  @ApiResponse({
    status: 201,
    description: 'Deposit/loan slab created successfully',
    type: DepositSlabResponseDto,
  })
  async createDepositLoanSlab(@Body() createDto: CreateDepositSlabDto) {
    return this.systemConfigService.createDepositSlab(createDto);
  }

  @Patch('deposit-loan-slabs/:id')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Update deposit/loan slab' })
  @ApiResponse({
    status: 200,
    description: 'Deposit/loan slab updated successfully',
    type: DepositSlabResponseDto,
  })
  async updateDepositLoanSlab(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDto: UpdateDepositSlabDto
  ) {
    return this.systemConfigService.updateDepositSlab(id, updateDto);
  }

  @Delete('deposit-loan-slabs/:id')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Delete deposit/loan slab' })
  @ApiResponse({
    status: 200,
    description: 'Deposit/loan slab deleted successfully',
  })
  async deleteDepositLoanSlab(@Param('id', ParseIntPipe) id: number) {
    return this.systemConfigService.deleteDepositSlab(id);
  }
}
