import { Controller, Get, Post, Body, Param, Patch, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SbAccountService } from '../services/sb-account.service';
import { CreateSbAccountDto, UpdateSbAccountDto } from '../dto/sb-account.dto';

@ApiTags('Admin - SB Account')
@Controller('admin/sb-accounts')
export class SbAccountController {
    constructor(private readonly sbAccountService: SbAccountService) { }

    @Post()
    @ApiOperation({ summary: 'Create a new SB Account' })
    @ApiResponse({ status: 201, description: 'The SB Account has been successfully created.' })
    create(@Body() createDto: CreateSbAccountDto) {
        return this.sbAccountService.create(createDto);
    }

    @Get()
    @ApiOperation({ summary: 'Get all SB Accounts' })
    @ApiResponse({ status: 200, description: 'Return all SB Accounts.' })
    findAll() {
        return this.sbAccountService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get an SB Account by ID' })
    @ApiResponse({ status: 200, description: 'Return the SB Account.' })
    findOne(@Param('id') id: string) {
        return this.sbAccountService.findOne(id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update an SB Account' })
    @ApiResponse({ status: 200, description: 'The SB Account has been successfully updated.' })
    update(@Param('id') id: string, @Body() updateDto: UpdateSbAccountDto) {
        return this.sbAccountService.update(id, updateDto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete an SB Account' })
    @ApiResponse({ status: 200, description: 'The SB Account has been successfully deleted.' })
    remove(@Param('id') id: string) {
        return this.sbAccountService.remove(id);
    }
}
