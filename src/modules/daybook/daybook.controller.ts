import { Controller, Get, Post, Query, Body, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { DayBookService } from './daybook.service';
import {
  GetDayBookDto,
  DayBookSummaryDto,
  InterestCalculationDto,
  InterestPaymentDto
} from './dto/daybook.dto';

@ApiTags('Day Book')
@Controller('daybook')
export class DayBookController {
  private readonly logger = new Logger(DayBookController.name);

  constructor(private readonly dayBookService: DayBookService) {}

  // BUG FIX: both report endpoints below manually wrapped their payload in
  // {success, data, message} on top of the global TransformInterceptor's
  // identical wrap — same double-wrap pattern fixed repeatedly elsewhere this
  // session. Harmless here specifically because the frontend already
  // defensively unwraps both shapes (`response.data?.data ?? response.data`),
  // but fixed anyway for consistency — every other endpoint of this shape has
  // been fixed, and there's no reason for the frontend's defensive fallback to
  // need to exist at all.
  @ApiOperation({ summary: 'Day book report (all day transactions) for a given date, optionally filtered' })
  @Get('report')
  async getDayBookReport(@Query() dto: GetDayBookDto): Promise<DayBookSummaryDto> {
    this.logger.log(`Generating day book report for date: ${dto.date}, filter: ${dto.filterType || 'all'}`);
    return this.dayBookService.getDayBookReport(dto);
  }

  @ApiOperation({ summary: 'Day book report limited to savings-bank (SB) transactions for a date' })
  @Get('report/sb')
  async getDayBookSBReport(@Query() dto: GetDayBookDto): Promise<DayBookSummaryDto> {
    this.logger.log(`Generating day book SB report for date: ${dto.date}`);
    return this.dayBookService.getDayBookSBReport(dto.date);
  }

  @ApiOperation({ summary: 'List active members holding savings accounts' })
  @Get('active-members')
  async getActiveMembersWithSavings(): Promise<any[]> {
    this.logger.log('Fetching active members with savings accounts');
    return this.dayBookService.getActiveMembersWithSavings();
  }

  @ApiOperation({ summary: 'Calculate accrued savings interest for a member over a period (preview, no posting)' })
  @Post('calculate-interest')
  async calculateInterest(@Body() dto: InterestCalculationDto): Promise<{
    success: boolean;
    data: any;
    message: string;
  }> {
    this.logger.log(`Calculating interest for member: ${dto.memberCode}`);
    
    const calculation = await this.dayBookService.calculateMemberInterest(dto);
    
    return {
      success: true,
      data: calculation,
      message: 'Interest calculated successfully'
    };
  }

  @ApiOperation({ summary: 'Post an interest payment to a member savings account' })
  @Post('pay-interest')
  async payInterest(@Body() dto: InterestPaymentDto): Promise<{
    success: boolean;
    data: any;
    message: string;
  }> {
    this.logger.log(`Processing interest payment for member: ${dto.memberCode}`);
    
    const result = await this.dayBookService.payInterestToMember(dto);
    
    return {
      success: true,
      data: result,
      message: 'Interest payment processed successfully'
    };
  }

  @ApiOperation({ summary: 'Current savings interest rate used by the day book' })
  @Get('interest-rate')
  async getCurrentInterestRate(): Promise<{
    success: boolean;
    data: { rate: number };
    message: string;
  }> {
    const rate = await this.dayBookService.getCurrentInterestRate();
    
    return {
      success: true,
      data: { rate },
      message: 'Current interest rate retrieved successfully'
    };
  }
}