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

    @Post('levels')
    @Roles(UserRole.ADMIN, 'sample_1' as any)
    @RequirePermissions(UserPermission.MANAGE_USERS)
    @ApiOperation({ summary: 'Create a new user level' })
    @ApiResponse({ status: HttpStatus.CREATED, description: 'User level created successfully' })
    async createUserLevel(@Body() body: { roleName: string }) {
        return this.roleManagementService.createUserLevel(body.roleName);
    }

    @Post('defaults')
    @Roles(UserRole.ADMIN, 'sample_1' as any)
    @RequirePermissions(UserPermission.MANAGE_USERS)
    @ApiOperation({ summary: 'Update default rights for a user level' })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'Default rights updated successfully',
    })
    async updateDefaultRights(@Body() updateDto: UpdateDefaultRightsDto) {
        return this.roleManagementService.updateDefaultRights(updateDto);
    }
}
