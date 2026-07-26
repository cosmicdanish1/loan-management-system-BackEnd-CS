import { Controller, Get, Post, Body, Param, Delete, Put, UseGuards, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CertificateTemplateService } from '../services';
import { CreateCertificateTemplateDto, UpdateCertificateTemplateDto } from '../dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../../auth/guards/role.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { UserRole } from '../../auth/entities/user.entity';

@ApiTags('Admin - Certificate Templates')
@ApiBearerAuth('JWT-auth')
@Controller('admin/certificate-templates')
@UseGuards(JwtAuthGuard, RoleGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
export class CertificateTemplateController {
    constructor(private readonly templateService: CertificateTemplateService) { }

    @ApiOperation({ summary: 'List all certificate templates' })
    @Get()
    findAll() {
        return this.templateService.findAll();
    }

    @ApiOperation({ summary: 'Get the default certificate template for an account type' })
    @Get('default')
    findDefault(@Query('accountType') accountType: string) {
        return this.templateService.findDefaultByAccountType(accountType);
    }

    @ApiOperation({ summary: 'Get a certificate template by id' })
    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.templateService.findOne(+id);
    }

    @ApiOperation({ summary: 'Create a certificate template' })
    @Post()
    create(@Body() dto: CreateCertificateTemplateDto) {
        return this.templateService.create(dto);
    }

    @ApiOperation({ summary: 'Update a certificate template by id' })
    @Put(':id')
    update(@Param('id') id: string, @Body() dto: UpdateCertificateTemplateDto) {
        return this.templateService.update(+id, dto);
    }

    @ApiOperation({ summary: 'Delete a certificate template by id' })
    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.templateService.remove(+id);
    }
}
