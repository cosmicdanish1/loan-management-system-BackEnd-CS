import { Controller, Get, Query, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { UtilitiesService } from './utilities.service';

@ApiTags('Utilities')
@Controller('utilities')
export class UtilitiesController {
  private readonly logger = new Logger(UtilitiesController.name);

  constructor(private readonly utilitiesService: UtilitiesService) {}

  @Get('search/deposits')
  @ApiOperation({ summary: 'Search for deposit accounts (RD/FD) by member number' })
  @ApiQuery({ name: 'memberNo', type: 'string', description: 'Member number' })
  @ApiQuery({ name: 'type', type: 'string', enum: ['RD', 'FD'], description: 'Deposit type' })
  @ApiResponse({
    status: 200,
    description: 'Deposit accounts retrieved successfully',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          accountNumber: { type: 'string' },
          memberId: { type: 'number' },
          monthlyInstallment: { type: 'number' },
          interestRate: { type: 'number' },
          startDate: { type: 'string', format: 'date' },
          maturityDate: { type: 'string', format: 'date' },
          tenureMonths: { type: 'number' },
          maturityAmount: { type: 'number' },
          totalDeposited: { type: 'number' },
          installmentsPaid: { type: 'number' },
          status: { type: 'string' }
        }
      }
    }
  })
  async searchDeposits(
    @Query('memberNo') memberNo: string,
    @Query('type') type: 'RD' | 'FD'
  ): Promise<{
    success: boolean;
    data: any[];
    message: string;
  }> {
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
  @ApiQuery({ name: 'memberNo', type: 'string', description: 'Member number' })
  @ApiResponse({
    status: 200,
    description: 'SB accounts retrieved successfully',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          accountNumber: { type: 'string' },
          memberId: { type: 'number' },
          interestRate: { type: 'number' },
          currentBalance: { type: 'number' },
          openingDate: { type: 'string', format: 'date' },
          minimumBalance: { type: 'number' },
          status: { type: 'string' },
          lastTransactionDate: { type: 'string', format: 'date' }
        }
      }
    }
  })
  async searchSBAccounts(
    @Query('memberNo') memberNo: string
  ): Promise<{
    success: boolean;
    data: any[];
    message: string;
  }> {
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
  @ApiQuery({ name: 'memberNo', type: 'string', description: 'Member number' })
  @ApiResponse({
    status: 200,
    description: 'Member eligibility retrieved successfully'
  })
  async getMemberEligibility(
    @Query('memberNo') memberNo: string
  ): Promise<{
    success: boolean;
    data: any;
    message: string;
  }> {
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
  @ApiQuery({ name: 'memberNo', type: 'string', description: 'Member number' })
  @ApiResponse({
    status: 200,
    description: 'Member balance retrieved successfully'
  })
  async getMemberBalance(
    @Query('memberNo') memberNo: string
  ): Promise<{
    success: boolean;
    data: any;
    message: string;
  }> {
    this.logger.log(`Getting balance for member: ${memberNo}`);

    const balance = await this.utilitiesService.getMemberBalance(memberNo);

    return {
      success: true,
      data: balance,
      message: 'Member balance retrieved successfully'
    };
  }
}