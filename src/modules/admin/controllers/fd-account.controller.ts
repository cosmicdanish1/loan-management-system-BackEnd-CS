import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { FdAccountService } from '../services/fd-account.service';
import { UpdateFdAccountDto } from '../dto/fd-account.dto';

@ApiTags('Admin - FD Accounts')
@Controller('admin/fd-accounts')
export class FdAccountController {
    constructor(private readonly fdAccountService: FdAccountService) { }

    @Get(':accountNumber')
    @ApiOperation({ summary: 'Get FD account by Account Number' })
    @ApiResponse({ status: 200, description: 'Return the FD account details.' })
    @ApiResponse({ status: 404, description: 'FD Account not found.' })
    findOne(@Param('accountNumber') accountNumber: string) {
        return this.fdAccountService.findOne(+accountNumber);
    }

    @Patch(':accountNumber')
    @ApiOperation({ summary: 'Update FD account details' })
    @ApiResponse({ status: 200, description: 'FD Account updated successfully.' })
    @ApiResponse({ status: 404, description: 'FD Account not found.' })
    update(@Param('accountNumber') accountNumber: string, @Body() updateDto: UpdateFdAccountDto) {
        return this.fdAccountService.update(+accountNumber, updateDto);
    }
}
