import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { InterestService } from './interest.service';
import {
  UpdateSavingInterestDto,
  InterestRunSummaryDto,
  InterestHistoryDto,
} from './dto';

@ApiTags('Interest Management')
@Controller('interest')
@ApiBearerAuth()
export class InterestController {
  constructor(private readonly interestService: InterestService) {}

  @Post('update-saving-interest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Calculate and update saving interest for all eligible members' })
  @ApiResponse({
    status: 200,
    description: 'Interest calculation completed successfully',
    type: InterestRunSummaryDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid parameters or interest already calculated for period',
  })
  async updateSavingInterest(
    @Body() dto: UpdateSavingInterestDto,
  ): Promise<InterestRunSummaryDto> {
    return this.interestService.updateSavingInterest(dto);
  }

  @Post('preview-calculation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Preview interest calculation without saving to database' })
  @ApiResponse({
    status: 200,
    description: 'Interest calculation preview generated successfully',
    type: InterestRunSummaryDto,
  })
  async previewInterestCalculation(
    @Body() dto: UpdateSavingInterestDto,
  ): Promise<InterestRunSummaryDto> {
    return this.interestService.previewInterestCalculation(dto);
  }

  @Post('validate-parameters')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate interest calculation parameters' })
  @ApiResponse({
    status: 200,
    description: 'Parameter validation result',
  })
  async validateParameters(
    @Body() dto: UpdateSavingInterestDto,
  ): Promise<{ valid: boolean; message: string; eligibleMembers?: number }> {
    return this.interestService.validateInterestParameters(dto);
  }

  @Get('history')
  @ApiOperation({ summary: 'Get interest calculation history' })
  @ApiResponse({
    status: 200,
    description: 'Interest calculation history retrieved successfully',
    type: [InterestHistoryDto],
  })
  async getInterestHistory(): Promise<InterestHistoryDto[]> {
    return this.interestService.getInterestHistory();
  }

  @Get('current-rate')
  @ApiOperation({ summary: 'Get current interest rate for savings accounts' })
  @ApiResponse({
    status: 200,
    description: 'Current interest rate retrieved successfully',
  })
  async getCurrentInterestRate(): Promise<{ rate: number }> {
    const rate = await this.interestService.getCurrentInterestRate();
    return { rate };
  }
}