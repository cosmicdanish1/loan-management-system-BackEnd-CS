import { Controller, Get, Post, Body, Patch, Param, Delete, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CastCategoryService } from '../services/cast-category.service';
import { CreateCastCategoryDto, UpdateCastCategoryDto } from '../dto/cast-category.dto';

@ApiTags('Admin - Cast Categories')
@Controller('admin/cast-categories')
export class CastCategoryController {
    private readonly logger = new Logger(CastCategoryController.name);

    constructor(private readonly castCategoryService: CastCategoryService) { }

    @Post()
    @ApiOperation({ summary: 'Create a new caste category' })
    async create(@Body() createCastCategoryDto: CreateCastCategoryDto) {
        this.logger.log(`[CastCategory] CREATE: ${JSON.stringify(createCastCategoryDto)}`);
        return this.castCategoryService.create(createCastCategoryDto);
    }

    @Get()
    @ApiOperation({ summary: 'Get all caste categories' })
    async findAll() {
        this.logger.log('[CastCategory] GET all');
        return this.castCategoryService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a caste category by ID' })
    async findOne(@Param('id') id: string) {
        this.logger.log(`[CastCategory] GET id=${id}`);
        return this.castCategoryService.findOne(+id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update a caste category' })
    async update(@Param('id') id: string, @Body() updateCastCategoryDto: UpdateCastCategoryDto) {
        this.logger.log(`[CastCategory] PATCH id=${id}: ${JSON.stringify(updateCastCategoryDto)}`);
        return this.castCategoryService.update(+id, updateCastCategoryDto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a caste category' })
    async remove(@Param('id') id: string) {
        this.logger.log(`[CastCategory] DELETE id=${id}`);
        return this.castCategoryService.remove(+id);
    }
}
