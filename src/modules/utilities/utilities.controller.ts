import { Controller, Get, Patch, Body, Query, Param, Logger, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { UtilitiesService } from './utilities.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  SearchDepositsDto,
  SearchSBAccountsDto,
  MemberEligibilityDto,
  MemberBalanceDto
} from './dto/search-params.dto';
import { UpdateUserPreferenceDto } from './dto/update-user-preference.dto';

@ApiTags('Utilities')
@Controller('utilities')
export class UtilitiesController {
  private readonly logger = new Logger(UtilitiesController.name);

  constructor(private readonly utilitiesService: UtilitiesService) { }

  @Get('search/deposits')
  @ApiOperation({ summary: 'Search for deposit accounts (RD/FD) by member number' })
  async searchDeposits(
    @Query() query: SearchDepositsDto
  ): Promise<{
    success: boolean;
    data: any[];
    message: string;
  }> {
    const { memberNo, type } = query;
    this.logger.log(`Searching ${type} deposits for member: ${memberNo}`);

    const deposits = await this.utilitiesService.searchDeposits(memberNo, type);

    return {
      success: true,
      data: deposits,
      message: `${type} deposits retrieved successfully`
    };
  }

  @Get('search/sb-accounts')
  @ApiOperation({ summary: 'Search for savings bank accounts by member number' })
  async searchSBAccounts(
    @Query() query: SearchSBAccountsDto
  ): Promise<{
    success: boolean;
    data: any[];
    message: string;
  }> {
    const { memberNo } = query;
    this.logger.log(`Searching SB accounts for member: ${memberNo}`);

    const sbAccounts = await this.utilitiesService.searchSBAccounts(memberNo);

    return {
      success: true,
      data: sbAccounts,
      message: 'SB accounts retrieved successfully'
    };
  }

  @Get('calculator/loan-rates')
  @ApiOperation({ summary: 'Get current loan interest rates from business rules' })
  @ApiResponse({
    status: 200,
    description: 'Loan rates retrieved successfully'
  })
  async getLoanRates(): Promise<{
    success: boolean;
    data: any[];
    message: string;
  }> {
    this.logger.log('Getting current loan rates');

    const loanRates = await this.utilitiesService.getLoanRates();

    return {
      success: true,
      data: loanRates,
      message: 'Loan rates retrieved successfully'
    };
  }

  @Get('calculator/member-eligibility')
  @ApiOperation({ summary: 'Check loan eligibility for a member' })
  async getMemberEligibility(
    @Query() query: MemberEligibilityDto
  ): Promise<{
    success: boolean;
    data: any;
    message: string;
  }> {
    const { memberNo } = query;
    this.logger.log(`Getting loan eligibility for member: ${memberNo}`);

    const eligibility = await this.utilitiesService.getMemberEligibility(memberNo);

    return {
      success: true,
      data: eligibility,
      message: 'Member eligibility retrieved successfully'
    };
  }

  @Get('member/balance')
  @ApiOperation({ summary: 'Get member balance information' })
  async getMemberBalance(
    @Query() query: MemberBalanceDto
  ): Promise<{
    success: boolean;
    data: any;
    message: string;
  }> {
    const { memberNo } = query;
    this.logger.log(`Getting balance for member: ${memberNo}`);

    const balance = await this.utilitiesService.getMemberBalance(memberNo);

    return {
      success: true,
      data: balance,
      message: 'Member balance retrieved successfully'
    };
  }

  @Get('preferences')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get current user UI preferences' })
  async getPreferences(@Req() req: any) {
    const userId = req.user.id;
    const data = await this.utilitiesService.getUserPreferences(userId);
    return {
      success: true,
      data,
      message: 'User preferences retrieved successfully'
    };
  }

  @Patch('preferences')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update user UI preferences' })
  async updatePreferences(@Req() req: any, @Body() updateDto: UpdateUserPreferenceDto) {
    const userId = req.user.id;
    const data = await this.utilitiesService.updateUserPreferences(userId, updateDto);
    return {
      success: true,
      data,
      message: 'User preferences updated successfully'
    };
  }

  @Get('system-settings/:key')
  @ApiOperation({ summary: 'Get global system setting' })
  async getSystemSetting(@Param('key') key: string) {
    const value = await this.utilitiesService.getSystemSetting(key);
    return {
      success: true,
      data: value
    };
  }

  @Patch('system-settings/:key')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update global system setting' })
  async updateSystemSetting(@Param('key') key: string, @Body('value') value: string) {
    const data = await this.utilitiesService.updateSystemSetting(key, value);
    return {
      success: true,
      data,
      message: 'System setting updated successfully'
    };
  }
}
