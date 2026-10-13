import {
    Controller,
    Get,
    Post,
    Body,
    Param,
    UseGuards,
    HttpStatus,
    ParseIntPipe,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiResponse,
    ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../../auth/guards/role.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { UserRole, UserPermission } from '../../auth/entities/user.entity';
import { RoleManagementService } from '../services/role-management.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AlertBridge } from '../../alerts/alert-bridge';
import { UpdateDefaultRightsDto, UserLevelResponseDto, MenuResponseDto } from '../dto/role-management.dto';

@ApiTags('Role Management')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RoleGuard, PermissionsGuard)
@Controller('admin/roles')
export class RoleManagementController {
    constructor(private readonly roleManagementService: RoleManagementService) { }

    @Get('levels')
    @Roles(UserRole.ADMIN, 'sample_1' as any)
    @RequirePermissions(UserPermission.MANAGE_USERS)
    @ApiOperation({ summary: 'Get all user levels' })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'User levels retrieved successfully',
        type: [UserLevelResponseDto],
    })
    async findAllUserLevels() {
        return this.roleManagementService.findAllUserLevels();
    }

    @Get('menus')
    @Roles(UserRole.ADMIN, 'sample_1' as any)
    @RequirePermissions(UserPermission.MANAGE_USERS)
    @ApiOperation({ summary: 'Get all menu items' })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'Menu items retrieved successfully',
        type: [MenuResponseDto],
    })
    async findAllMenus() {
        return this.roleManagementService.findAllMenus();
    }

    @Get('defaults/:levelId')
    @Roles(UserRole.ADMIN, 'sample_1' as any)
    @RequirePermissions(UserPermission.MANAGE_USERS)
    @ApiOperation({ summary: 'Get default rights for a user level' })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'Default rights retrieved successfully',
    })
    async getDefaultRights(@Param('levelId', ParseIntPipe) levelId: number) {
        return this.roleManagementService.getDefaultRights(levelId);
    }

    @Post('defaults')
    @Roles(UserRole.ADMIN, 'sample_1' as any)
    @RequirePermissions(UserPermission.MANAGE_USERS)
    @ApiOperation({ summary: 'Update default rights for a user level' })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'Default rights updated successfully',
    })
    async updateDefaultRights(@Body() updateDto: UpdateDefaultRightsDto, @CurrentUser() actor: any) {
        // Read the old rights first so the alert can say how many were added/removed.
        const before: number[] = await this.roleManagementService.getDefaultRights(updateDto.userlevelid).catch(() => []);
        const result = await this.roleManagementService.updateDefaultRights(updateDto);
        try {
            const levels = await this.roleManagementService.findAllUserLevels();
            const level = levels.find((l: any) => l.userlevelid === updateDto.userlevelid);
            const now = new Set<number>(updateDto.menuIds);
            const old = new Set<number>(before);
            AlertBridge.get()?.rightsChanged({
                by: actor?.username,
                level: (level as any)?.userlevel ?? `#${updateDto.userlevelid}`,
                added: [...now].filter((m) => !old.has(m)).length,
                removed: [...old].filter((m) => !now.has(m)).length,
                total: now.size,
            });
        } catch { /* alerting must never affect rights changes */ }
        return result;
    }
}
