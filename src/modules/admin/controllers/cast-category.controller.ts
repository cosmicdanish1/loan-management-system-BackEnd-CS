import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CastCategoryService } from '../services/cast-category.service';
import { CreateCastCategoryDto, UpdateCastCategoryDto } from '../dto/cast-category.dto';

@ApiTags('Admin - Cast Categories')
@Controller('admin/cast-categories')
export class CastCategoryController {
    constructor(private readonly castCategoryService: CastCategoryService) { }

    @Post()
    @ApiOperation({ summary: 'Create a new caste category' })
    @ApiResponse({ status: 201, description: 'Caste category created successfully.' })
    create(@Body() createCastCategoryDto: CreateCastCategoryDto) {
        return this.castCategoryService.create(createCastCategoryDto);
    }

    @Get()
    @ApiOperation({ summary: 'Get all caste categories' })
    @ApiResponse({ status: 200, description: 'Return all caste categories.' })
    findAll() {
        return this.castCategoryService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a caste category by ID' })
    @ApiResponse({ status: 200, description: 'Return the caste category.' })
    @ApiResponse({ status: 404, description: 'Caste category not found.' })
    findOne(@Param('id') id: string) {
        return this.castCategoryService.findOne(+id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update a caste category' })
    @ApiResponse({ status: 200, description: 'Caste category updated successfully.' })
    @ApiResponse({ status: 404, description: 'Caste category not found.' })
    update(@Param('id') id: string, @Body() updateCastCategoryDto: UpdateCastCategoryDto) {
        return this.castCategoryService.update(+id, updateCastCategoryDto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a caste category' })
    @ApiResponse({ status: 200, description: 'Caste category deleted successfully.' })
    @ApiResponse({ status: 404, description: 'Caste category not found.' })
    remove(@Param('id') id: string) {
        return this.castCategoryService.remove(+id);
    }
}
