import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, HttpStatus, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { PassbookTemplateService } from '../services/passbook-template.service';
import { CreatePassbookTemplateDto, UpdatePassbookTemplateDto } from '../dto';
import { JwtAuthGuard, RoleGuard } from '../../auth/guards';
import { Roles } from '../../auth/decorators/roles.decorator';
import { UserRole } from '../../auth/entities/user.entity';

@ApiTags('Admin - Passbook Templates')
@Controller('admin/passbook-templates')
@UseGuards(JwtAuthGuard, RoleGuard)
@ApiBearerAuth()
@Roles(UserRole.ADMIN, UserRole.MANAGER)
export class PassbookTemplateController {
    constructor(private readonly templateService: PassbookTemplateService) { }

    @Get()
    @ApiOperation({ summary: 'Get all passbook templates' })
    findAll() {
        return this.templateService.findAll();
    }

    @Get('default')
    @ApiOperation({ summary: 'Get default passbook template by account type' })
    findDefault(@Query('accountType') accountType: string) {
        return this.templateService.findDefaultByAccountType(accountType);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get passbook template by ID' })
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.templateService.findOne(id);
    }

    @Post()
    @ApiOperation({ summary: 'Create a new passbook template' })
    @ApiResponse({ status: HttpStatus.CREATED, description: 'Template created successfully' })
    create(@Body() dto: CreatePassbookTemplateDto) {
        return this.templateService.create(dto);
    }

    @Put(':id')
    @ApiOperation({ summary: 'Update an existing passbook template' })
    update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePassbookTemplateDto) {
        return this.templateService.update(id, dto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a passbook template' })
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.templateService.remove(id);
    }
}
