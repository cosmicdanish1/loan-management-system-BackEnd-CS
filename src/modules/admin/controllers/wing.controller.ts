import { Controller, Get, Post, Body, Param, Patch, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { WingService } from '../services/wing.service';
import { CreateWingDto, UpdateWingDto } from '../dto/wing.dto';

@ApiTags('Admin - Wing Master')
@Controller('admin/wings')
export class WingController {
    constructor(private readonly wingService: WingService) { }

    @Post()
    @ApiOperation({ summary: 'Create a new wing' })
    @ApiResponse({ status: 201, description: 'The wing has been successfully created.' })
    create(@Body() createDto: CreateWingDto) {
        return this.wingService.create(createDto);
    }

    @Get()
    @ApiOperation({ summary: 'Get all wings' })
    @ApiResponse({ status: 200, description: 'Return all wings.' })
    findAll() {
        return this.wingService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a wing by ID' })
    @ApiResponse({ status: 200, description: 'Return the wing.' })
    findOne(@Param('id') id: string) {
        return this.wingService.findOne(id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update a wing' })
    @ApiResponse({ status: 200, description: 'The wing has been successfully updated.' })
    update(@Param('id') id: string, @Body() updateDto: UpdateWingDto) {
        return this.wingService.update(id, updateDto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a wing' })
    @ApiResponse({ status: 200, description: 'The wing has been successfully deleted.' })
    remove(@Param('id') id: string) {
        return this.wingService.remove(id);
    }
}
