import { Controller, Get, Post, Body, Param, Patch, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RdAccountService } from '../services/rd-account.service';
import { CreateRdAccountDto, UpdateRdAccountDto } from '../dto/rd-account.dto';

@ApiTags('Admin - RD Account')
@Controller('admin/rd-accounts')
export class RdAccountController {
    constructor(private readonly rdAccountService: RdAccountService) { }

    @Post()
    @ApiOperation({ summary: 'Create a new RD Account' })
    @ApiResponse({ status: 201, description: 'The RD Account has been successfully created.' })
    create(@Body() createDto: CreateRdAccountDto) {
        return this.rdAccountService.create(createDto);
    }

    @Get()
    @ApiOperation({ summary: 'Get all RD Accounts' })
    @ApiResponse({ status: 200, description: 'Return all RD Accounts.' })
    findAll() {
        return this.rdAccountService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get an RD Account by ID' })
    @ApiResponse({ status: 200, description: 'Return the RD Account.' })
    findOne(@Param('id') id: number) {
        return this.rdAccountService.findOne(id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update an RD Account' })
    @ApiResponse({ status: 200, description: 'The RD Account has been successfully updated.' })
    update(@Param('id') id: number, @Body() updateDto: UpdateRdAccountDto) {
        return this.rdAccountService.update(id, updateDto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete an RD Account' })
    @ApiResponse({ status: 200, description: 'The RD Account has been successfully deleted.' })
    remove(@Param('id') id: number) {
        return this.rdAccountService.remove(id);
    }
}
