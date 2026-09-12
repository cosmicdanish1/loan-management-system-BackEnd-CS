import { Controller, Get, Post, Body, Param, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../../auth/guards/role.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { UserRole, UserPermission } from '../../auth/entities/user.entity';
import { FinancialYearService } from '../services/financial-year.service';

@ApiTags('Financial Year Management')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RoleGuard, PermissionsGuard)
@Controller('admin/financial-year')
export class FinancialYearController {
    constructor(private readonly financialYearService: FinancialYearService) { }

    @Get('list')
    @Roles(UserRole.ADMIN, UserRole.MANAGER)
    @ApiOperation({ summary: 'Get all financial years' })
    async getYears() {
        return this.financialYearService.getFinancialYears();
    }

    @Get('current')
    @Roles(UserRole.ADMIN, UserRole.MANAGER)
    @ApiOperation({ summary: 'Get current active financial year' })
    async getCurrentYear() {
        return this.financialYearService.getCurrentFinancialYear();
    }

    @Post('transfer-entries')
    @Roles(UserRole.ADMIN)
    @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
    @ApiOperation({ summary: 'Initiate transfer entries for year closing' })
    async initiateTransfer(@Body('yearCode') yearCode: number, @Request() req: any) {
        const username = req.user?.username || 'admin';
        return this.financialYearService.initiateTransfer(yearCode, username);
    }

    @Post('balance-transfer')
    @Roles(UserRole.ADMIN)
    @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
    @ApiOperation({ summary: 'Perform manual balance transfer between accounts' })
    async balanceTransfer(@Body() transferData: any, @Request() req: any) {
        const username = req.user?.username || 'admin';
        return this.financialYearService.performBalanceTransfer(transferData, username);
    }

    @Post('pl-year-end-process')
    @Roles(UserRole.ADMIN)
    @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
    @ApiOperation({ summary: 'Initiate P&L Year End Process' })
    async plYearEndProcess(@Request() req: any) {
        const username = req.user?.username || 'admin';
        return this.financialYearService.performPLYearEndProcess(username);
    }

    // BUG FIX 4: New endpoint — formally closes a financial year by stamping closed_at.
    // This is the action that FinancialYearClosing.tsx triggers after the admin confirms.
    @Post('close-year')
    @Roles(UserRole.ADMIN)
    @RequirePermissions(UserPermission.MANAGE_SYSTEM_CONFIG)
    @ApiOperation({ summary: 'Formally close (lock) a financial year' })
    async closeYear(@Body('yearCode') yearCode: number, @Request() req: any) {
        const username = req.user?.username || 'admin';
        return this.financialYearService.closeFinancialYear(yearCode, username);
    }
}
