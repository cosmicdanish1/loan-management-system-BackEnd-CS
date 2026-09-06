import { Controller, Get, Patch, Body, Param, Query, Logger, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../../auth/guards/role.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { UserRole, UserPermission } from '../../auth/entities/user.entity';
import { FdAccountService } from '../services/fd-account.service';
import { UpdateFdAccountDto } from '../dto/fd-account.dto';

@ApiTags('Admin - FD Accounts')
@ApiBearerAuth()
// BUG FIX: only the app-wide JwtAuthGuard applied — any logged-in user, regardless
// of assigned menu rights, could read/modify any FD account directly via the API.
// Matches the RoleGuard/PermissionsGuard pattern already used by every sibling
// admin/controllers/*.controller.ts (financial-year, day-end, user-management, etc.).
@UseGuards(JwtAuthGuard, RoleGuard, PermissionsGuard)
@Controller('admin/fd-accounts')
export class FdAccountController {
    private readonly logger = new Logger(FdAccountController.name);

    constructor(private readonly fdAccountService: FdAccountService) { }

    @Get()
    @Roles(UserRole.ADMIN, UserRole.MANAGER)
    @RequirePermissions(UserPermission.READ_DEPOSIT)
    @ApiOperation({ summary: 'Get all FD accounts (or filter by memberNo)' })
    async findAll(@Query('memberNo') memberNo?: string) {
        if (memberNo) {
            this.logger.log(`[FdAccount] GET accounts for member: ${memberNo}`);
            return this.fdAccountService.findByMember(+memberNo);
        }
        this.logger.log('[FdAccount] GET all FD accounts');
        return this.fdAccountService.findAll();
    }

    @Get(':accountNumber')
    @Roles(UserRole.ADMIN, UserRole.MANAGER)
    @RequirePermissions(UserPermission.READ_DEPOSIT)
    @ApiOperation({ summary: 'Get FD account by Account Number' })
    @ApiResponse({ status: 200, description: 'Return the FD account details.' })
    @ApiResponse({ status: 404, description: 'FD Account not found.' })
    async findOne(@Param('accountNumber') accountNumber: string) {
        this.logger.log(`[FdAccount] GET account: ${accountNumber}`);
        return this.fdAccountService.findOne(+accountNumber);
    }

    @Patch(':accountNumber')
    @Roles(UserRole.ADMIN, UserRole.MANAGER)
    @RequirePermissions(UserPermission.UPDATE_DEPOSIT)
    @ApiOperation({ summary: 'Update FD account details' })
    @ApiResponse({ status: 200, description: 'FD Account updated successfully.' })
    @ApiResponse({ status: 404, description: 'FD Account not found.' })
    async update(@Param('accountNumber') accountNumber: string, @Body() updateDto: UpdateFdAccountDto) {
        this.logger.log(`[FdAccount] PATCH account: ${accountNumber}`);
        return this.fdAccountService.update(+accountNumber, updateDto);
    }
}
