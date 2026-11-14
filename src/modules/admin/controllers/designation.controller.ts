import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DesignationService } from '../services/designation.service';
import { CreateDesignationDto, UpdateDesignationDto } from '../dto/designation.dto';

import { RequireMenuAction } from '../../auth/guards/menu-right.guard';
@ApiTags('Admin - Designations')
@Controller('admin/designations')
export class DesignationController {
    constructor(private readonly designationService: DesignationService) { }

    @RequireMenuAction('DESIGNATION_MASTER') // ES-298

    @Post()
    @ApiOperation({ summary: 'Create a new designation' })
    @ApiResponse({ status: 201, description: 'Designation created successfully.' })
    create(@Body() createDesignationDto: CreateDesignationDto) {
        return this.designationService.create(createDesignationDto);
    }

    @Get()
    @ApiOperation({ summary: 'Get all designations' })
    @ApiResponse({ status: 200, description: 'Return all designations.' })
    findAll() {
        return this.designationService.findAll();
    }

    @Get(':code')
    @ApiOperation({ summary: 'Get a designation by code' })
    @ApiResponse({ status: 200, description: 'Return the designation.' })
    @ApiResponse({ status: 404, description: 'Designation not found.' })
    findOne(@Param('code') code: string) {
        return this.designationService.findOne(code);
    }

    @RequireMenuAction('DESIGNATION_MASTER') // ES-298

    @Patch(':code')
    @ApiOperation({ summary: 'Update a designation' })
    @ApiResponse({ status: 200, description: 'Designation updated successfully.' })
    @ApiResponse({ status: 404, description: 'Designation not found.' })
    update(@Param('code') code: string, @Body() updateDesignationDto: UpdateDesignationDto) {
        return this.designationService.update(code, updateDesignationDto);
    }

    @RequireMenuAction('DESIGNATION_MASTER') // ES-298

    @Delete(':code')
    @ApiOperation({ summary: 'Delete a designation' })
    @ApiResponse({ status: 200, description: 'Designation deleted successfully.' })
    @ApiResponse({ status: 404, description: 'Designation not found.' })
    remove(@Param('code') code: string) {
        return this.designationService.remove(code);
    }
}
