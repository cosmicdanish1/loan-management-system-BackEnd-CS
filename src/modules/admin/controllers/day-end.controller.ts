import {
  Controller,
  Get,
  Post,
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
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole, UserPermission } from '../../auth/entities/user.entity';
import { DayEndService } from '../services/day-end.service';
import {
  InitiateDayEndDto,
  DayEndProcessResponseDto,
  DayEndSummaryDto,
  InterestCalculationResultDto,
} from '../dto';

@ApiTags('Day-End Processing')
@ApiBearerAuth()
// TODO: Re-enable controller-level guards once auth system is properly configured
// @UseGuards(JwtAuthGuard, RoleGuard, PermissionsGuard)
@Controller('admin/day-end')
export class DayEndController {
  constructor(private readonly dayEndService: DayEndService) { }

  @Post('initiate')
  // TODO: Re-enable authentication once auth system is properly configured
  // @Roles(UserRole.ADMIN, UserRole.MANAGER)
  // @RequirePermissions(UserPermission.DAY_END_OPERATIONS)
  @ApiOperation({ summary: 'Initiate day-end processing' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Day-end process initiated successfully',
    type: DayEndProcessResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Day-end already completed or another process is running',
  })
  async initiateDayEnd(
    @Body() initiateDayEndDto: InitiateDayEndDto,
    @CurrentUser() user: any,
  ): Promise<DayEndProcessResponseDto> {
    // Use default user ID if not authenticated
    const userId = user?.id || 1;
    return this.dayEndService.initiateDayEnd(initiateDayEndDto, userId);
  }

  @Get('summary')
  // TODO: Re-enable authentication once auth system is properly configured
  // @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.ACCOUNTANT)
  // @RequirePermissions(UserPermission.DAY_END_OPERATIONS)
  @ApiOperation({ summary: 'Get current day-end summary' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Current day-end summary retrieved successfully',
  })
  async getCurrentDayEndSummary() {
    return this.dayEndService.getCurrentDayEndSummary();
  }

  // BUG FIX: getworkingdate starts empty and nothing else can create the
  // first row — see DayEndService.initializeWorkingDate for the full story.
  @Post('initialize')
  @ApiOperation({ summary: 'Create the genesis getworkingdate row (only when none exists)' })
  async initializeWorkingDate(@Body('workingDate') workingDate: string) {
    return this.dayEndService.initializeWorkingDate(workingDate);
  }

  @Delete('working-date')
  @ApiOperation({ summary: 'Reset a mis-set initial working date (only before any day-end has completed)' })
  async resetWorkingDate() {
    return this.dayEndService.resetWorkingDate();
  }

  @Get('processes')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermissions(UserPermission.DAY_END_OPERATIONS)
  @ApiOperation({ summary: 'Get all day-end processes' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Day-end processes retrieved successfully',
  })
  async getDayEndProcesses(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
  ) {
    return this.dayEndService.getDayEndProcesses(page, limit);
  }

  @Get('processes/:id')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermissions(UserPermission.DAY_END_OPERATIONS)
  @ApiOperation({ summary: 'Get day-end process by ID' })
  @ApiParam({ name: 'id', type: Number, description: 'Process ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Day-end process retrieved successfully',
    type: DayEndProcessResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Day-end process not found',
  })
  async getDayEndProcess(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DayEndProcessResponseDto> {
    return this.dayEndService.getDayEndProcess(id);
  }

  @Get('processes/:id/summary')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermissions(UserPermission.DAY_END_OPERATIONS)
  @ApiOperation({ summary: 'Get day-end process summary' })
  @ApiParam({ name: 'id', type: Number, description: 'Process ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Day-end process summary retrieved successfully',
    type: DayEndSummaryDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Day-end process not found',
  })
  async getDayEndSummary(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DayEndSummaryDto> {
    return this.dayEndService.getDayEndSummary(id);
  }

  @Get('processes/:id/interest-calculations')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.ACCOUNTANT)
  @RequirePermissions(UserPermission.DAY_END_OPERATIONS)
  @ApiOperation({ summary: 'Get interest calculation results for a day-end process' })
  @ApiParam({ name: 'id', type: Number, description: 'Process ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Interest calculation results retrieved successfully',
    type: [InterestCalculationResultDto],
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Day-end process not found',
  })
  async getInterestCalculationResults(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<InterestCalculationResultDto[]> {
    return this.dayEndService.getInterestCalculationResults(id);
  }
}
