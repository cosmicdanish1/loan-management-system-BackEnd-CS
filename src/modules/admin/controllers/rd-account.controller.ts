import { Controller, Get, Post, Body, Param, Patch, Delete, Query, ParseIntPipe } from '@nestjs/common';
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
    @ApiOperation({ summary: 'Get all RD Accounts, optionally filtered by memberNo' })
    @ApiResponse({ status: 200, description: 'Return all RD Accounts.' })
    findAll(@Query('memberNo') memberNo?: string) {
        return this.rdAccountService.findAll(memberNo);
    }

    @Get('next-number')
    @ApiOperation({ summary: 'Get next auto-generated account number (MAX + 1 from fdmaster)' })
    getNextAccountNumber() {
        return this.rdAccountService.getNextAccountNumber();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get an RD Account by ID' })
    @ApiResponse({ status: 200, description: 'Return the RD Account.' })
    // BUG FIX 3: @Param without ParseIntPipe passes a string at runtime despite `number` type annotation
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.rdAccountService.findOne(id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update an RD Account' })
    @ApiResponse({ status: 200, description: 'The RD Account has been successfully updated.' })
    update(@Param('id', ParseIntPipe) id: number, @Body() updateDto: UpdateRdAccountDto) {
        return this.rdAccountService.update(id, updateDto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete an RD Account' })
    @ApiResponse({ status: 200, description: 'The RD Account has been successfully deleted.' })
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.rdAccountService.remove(id);
    }
}
