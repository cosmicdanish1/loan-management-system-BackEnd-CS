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

  @ApiOperation({ summary: 'Day book report (all day transactions) for a given date, optionally filtered' })
  @Get('report')
  async getDayBookReport(@Query() dto: GetDayBookDto): Promise<{
    success: boolean;
    data: DayBookSummaryDto;
    message: string;
  }> {
    this.logger.log(`Generating day book report for date: ${dto.date}, filter: ${dto.filterType || 'all'}`);
    
    const report = await this.dayBookService.getDayBookReport(dto);
    
    return {
      success: true,
      data: report,
      message: 'Day book report generated successfully'
    };
  }

  @ApiOperation({ summary: 'Day book report limited to savings-bank (SB) transactions for a date' })
  @Get('report/sb')
  async getDayBookSBReport(@Query() dto: GetDayBookDto): Promise<{
    success: boolean;
    data: DayBookSummaryDto;
    message: string;
  }> {
    this.logger.log(`Generating day book SB report for date: ${dto.date}`);
    
    const report = await this.dayBookService.getDayBookSBReport(dto.date);
    
    return {
      success: true,
      data: report,
      message: 'Day book SB report generated successfully'
    };
  }

  @ApiOperation({ summary: 'List active members holding savings accounts' })
  @Get('active-members')
  async getActiveMembersWithSavings(): Promise<{
    success: boolean;
    data: any[];
    message: string;
  }> {
    this.logger.log('Fetching active members with savings accounts');
    
    const members = await this.dayBookService.getActiveMembersWithSavings();
    
    return {
      success: true,
      data: members,
      message: 'Active members retrieved successfully'
    };
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