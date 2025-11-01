import {
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
import { UserRole, UserPermission } from '../../auth/entities/user.entity';
import { SystemConfigService } from '../services/system-config.service';
import {
  CreateSystemConfigDto,
  UpdateSystemConfigDto,
  SystemConfigResponseDto,
  CreateInterestRateDto,
  UpdateInterestRateDto,
  InterestRateResponseDto,
  CreateDepositSlabDto,
  UpdateDepositSlabDto,
  DepositSlabResponseDto,
} from '../dto';
import {
  ConfigCategory,
} from '../entities/system-config.entity';
import {
  InterestRateType,
} from '../entities/interest-rate.entity';
import {
  DepositSlabType,
} from '../entities/deposit-slab.entity';

@ApiTags('System Configuration')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RoleGuard, PermissionsGuard)
@Controller('admin/config')
export class SystemConfigController {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  // System Configuration Endpoints
  @Post('system')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Create system configuration' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Configuration created successfully',
    type: SystemConfigResponseDto,
  })
  async createSystemConfig(
    @Body() createDto: CreateSystemConfigDto,
  ): Promise<SystemConfigResponseDto> {
    return this.systemConfigService.createSystemConfig(createDto);
  }

  @Get('system')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Get all system configurations' })
  @ApiQuery({ name: 'category', required: false, enum: ConfigCategory })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Configurations retrieved successfully',
    type: [SystemConfigResponseDto],
  })
  async findAllSystemConfigs(
    @Query('category') category?: ConfigCategory,
    @Query('isActive') isActive?: boolean,
  ): Promise<SystemConfigResponseDto[]> {
    return this.systemConfigService.findAllSystemConfigs(category, isActive);
  }

  @Get('system/key/:key')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Get system configuration by key' })
  @ApiParam({ name: 'key', type: String })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Configuration retrieved successfully',
    type: SystemConfigResponseDto,
  })
  async findSystemConfigByKey(
    @Param('key') key: string,
  ): Promise<SystemConfigResponseDto> {
    return this.systemConfigService.findSystemConfigByKey(key);
  }

  @Put('system/:id')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Update system configuration' })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Configuration updated successfully',
    type: SystemConfigResponseDto,
  })
  async updateSystemConfig(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDto: UpdateSystemConfigDto,
  ): Promise<SystemConfigResponseDto> {
    return this.systemConfigService.updateSystemConfig(id, updateDto);
  }

  @Delete('system/:id')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Delete system configuration' })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Configuration deleted successfully',
  })
  async deleteSystemConfig(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ message: string }> {
    return this.systemConfigService.deleteSystemConfig(id);
  }

  @Post('system/initialize')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Initialize default system configurations' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Default configurations initialized successfully',
  })
  async initializeDefaultConfigs(): Promise<{ message: string }> {
    await this.systemConfigService.initializeDefaultConfigs();
    return { message: 'Default configurations initialized successfully' };
  }

  // Interest Rate Endpoints
  @Post('interest-rates')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Create interest rate' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Interest rate created successfully',
    type: InterestRateResponseDto,
  })
  async createInterestRate(
    @Body() createDto: CreateInterestRateDto,
  ): Promise<InterestRateResponseDto> {
    return this.systemConfigService.createInterestRate(createDto);
  }

  @Get('interest-rates')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Get all interest rates' })
  @ApiQuery({ name: 'type', required: false, enum: InterestRateType })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Interest rates retrieved successfully',
    type: [InterestRateResponseDto],
  })
  async findAllInterestRates(
    @Query('type') type?: InterestRateType,
    @Query('isActive') isActive?: boolean,
  ): Promise<InterestRateResponseDto[]> {
    return this.systemConfigService.findAllInterestRates(type, isActive);
  }

  @Get('interest-rates/:id')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Get interest rate by ID' })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Interest rate retrieved successfully',
    type: InterestRateResponseDto,
  })
  async findInterestRateById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<InterestRateResponseDto> {
    return this.systemConfigService.findInterestRateById(id);
  }

  @Put('interest-rates/:id')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Update interest rate' })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Interest rate updated successfully',
    type: InterestRateResponseDto,
  })
  async updateInterestRate(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDto: UpdateInterestRateDto,
  ): Promise<InterestRateResponseDto> {
    return this.systemConfigService.updateInterestRate(id, updateDto);
  }

  @Delete('interest-rates/:id')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Delete interest rate' })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Interest rate deleted successfully',
  })
  async deleteInterestRate(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ message: string }> {
    return this.systemConfigService.deleteInterestRate(id);
  }

  // Deposit Slab Endpoints
  @Post('deposit-slabs')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Create deposit slab' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Deposit slab created successfully',
    type: DepositSlabResponseDto,
  })
  async createDepositSlab(
    @Body() createDto: CreateDepositSlabDto,
  ): Promise<DepositSlabResponseDto> {
    return this.systemConfigService.createDepositSlab(createDto);
  }

  @Get('deposit-slabs')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Get all deposit slabs' })
  @ApiQuery({ name: 'type', required: false, enum: DepositSlabType })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Deposit slabs retrieved successfully',
    type: [DepositSlabResponseDto],
  })
  async findAllDepositSlabs(
    @Query('type') type?: DepositSlabType,
    @Query('isActive') isActive?: boolean,
  ): Promise<DepositSlabResponseDto[]> {
    return this.systemConfigService.findAllDepositSlabs(type, isActive);
  }

  @Get('deposit-slabs/:id')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Get deposit slab by ID' })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Deposit slab retrieved successfully',
    type: DepositSlabResponseDto,
  })
  async findDepositSlabById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DepositSlabResponseDto> {
    return this.systemConfigService.findDepositSlabById(id);
  }

  @Put('deposit-slabs/:id')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Update deposit slab' })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Deposit slab updated successfully',
    type: DepositSlabResponseDto,
  })
  async updateDepositSlab(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDto: UpdateDepositSlabDto,
  ): Promise<DepositSlabResponseDto> {
    return this.systemConfigService.updateDepositSlab(id, updateDto);
  }

  @Delete('deposit-slabs/:id')
  @Roles(UserRole.ADMIN)
  @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
  @ApiOperation({ summary: 'Delete deposit slab' })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Deposit slab deleted successfully',
  })
  async deleteDepositSlab(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ message: string }> {
    return this.systemConfigService.deleteDepositSlab(id);
  }
}
