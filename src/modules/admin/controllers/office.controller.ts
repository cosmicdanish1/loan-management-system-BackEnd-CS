import { ParseIntPipe, Controller, Get, Post, Body, Param, Patch, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { OfficeService } from '../services/office.service';
import { CreateOfficeDto, UpdateOfficeDto } from '../dto/office.dto';

import { RequireMenuAction } from '../../auth/guards/menu-right.guard';
@ApiTags('Admin - Office Master')
@Controller('admin/offices')
export class OfficeController {
    constructor(private readonly officeService: OfficeService) { }

    @RequireMenuAction('WING_OFFICE_MASTER') // ES-298

    @Post()
    @ApiOperation({ summary: 'Create a new office' })
    @ApiResponse({ status: 201, description: 'The office has been successfully created.' })
    create(@Body() createDto: CreateOfficeDto) {
        return this.officeService.create(createDto);
    }

    @Get()
    @ApiOperation({ summary: 'Get all offices' })
    @ApiResponse({ status: 200, description: 'Return all offices.' })
    findAll() {
        return this.officeService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get an office by ID' })
    @ApiResponse({ status: 200, description: 'Return the office.' })
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.officeService.findOne(id);
    }

    @RequireMenuAction('WING_OFFICE_MASTER') // ES-298

    @Patch(':id')
    @ApiOperation({ summary: 'Update an office' })
    @ApiResponse({ status: 200, description: 'The office has been successfully updated.' })
    update(@Param('id', ParseIntPipe) id: number, @Body() updateDto: UpdateOfficeDto) {
        return this.officeService.update(id, updateDto);
    }

    @RequireMenuAction('WING_OFFICE_MASTER') // ES-298

    @Delete(':id')
    @ApiOperation({ summary: 'Delete an office' })
    @ApiResponse({ status: 200, description: 'The office has been successfully deleted.' })
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.officeService.remove(id);
    }
}
