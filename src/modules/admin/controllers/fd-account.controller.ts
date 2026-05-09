import { Controller, Get, Patch, Body, Param, Query, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { FdAccountService } from '../services/fd-account.service';
import { UpdateFdAccountDto } from '../dto/fd-account.dto';

@ApiTags('Admin - FD Accounts')
@Controller('admin/fd-accounts')
export class FdAccountController {
    private readonly logger = new Logger(FdAccountController.name);

    constructor(private readonly fdAccountService: FdAccountService) { }

    @Get()
    @ApiOperation({ summary: 'Get all FD accounts (or filter by memberNo)' })
    async findAll(@Query('memberNo') memberNo?: string) {
        if (memberNo) {
            this.logger.log(`[FdAccount] GET accounts for member: ${memberNo}`);
            return this.fdAccountService.findByMember(+memberNo);
        }
        this.logger.log('[FdAccount] GET all FD accounts');
        return this.fdAccountService.findAll();
    }

    @Get(':accountNumber')
    @ApiOperation({ summary: 'Get FD account by Account Number' })
    @ApiResponse({ status: 200, description: 'Return the FD account details.' })
    @ApiResponse({ status: 404, description: 'FD Account not found.' })
    async findOne(@Param('accountNumber') accountNumber: string) {
        this.logger.log(`[FdAccount] GET account: ${accountNumber}`);
        return this.fdAccountService.findOne(+accountNumber);
    }

    @Patch(':accountNumber')
    @ApiOperation({ summary: 'Update FD account details' })
    @ApiResponse({ status: 200, description: 'FD Account updated successfully.' })
    @ApiResponse({ status: 404, description: 'FD Account not found.' })
    async update(@Param('accountNumber') accountNumber: string, @Body() updateDto: UpdateFdAccountDto) {
        this.logger.log(`[FdAccount] PATCH account: ${accountNumber}`);
        return this.fdAccountService.update(+accountNumber, updateDto);
    }
}
