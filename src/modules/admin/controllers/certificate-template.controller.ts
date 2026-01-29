import { Controller, Get, Post, Body, Param, Delete, Put, UseGuards, Query } from '@nestjs/common';
import { CertificateTemplateService } from '../services';
import { CreateCertificateTemplateDto, UpdateCertificateTemplateDto } from '../dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../../auth/guards/role.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { UserRole } from '../../auth/entities/user.entity';

@Controller('admin/certificate-templates')
@UseGuards(JwtAuthGuard, RoleGuard)
@Roles(UserRole.ADMIN)
export class CertificateTemplateController {
    constructor(private readonly templateService: CertificateTemplateService) { }

    @Get()
    findAll() {
        return this.templateService.findAll();
    }

    @Get('default')
    findDefault(@Query('accountType') accountType: string) {
        return this.templateService.findDefaultByAccountType(accountType);
    }

    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.templateService.findOne(+id);
    }

    @Post()
    create(@Body() dto: CreateCertificateTemplateDto) {
        return this.templateService.create(dto);
    }

    @Put(':id')
    update(@Param('id') id: string, @Body() dto: UpdateCertificateTemplateDto) {
        return this.templateService.update(+id, dto);
    }

    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.templateService.remove(+id);
    }
}
