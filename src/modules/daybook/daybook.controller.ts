import { Controller, Get, Post, Query, Body, Logger } from '@nestjs/common';
import { DayBookService } from './daybook.service';
import { 
  GetDayBookDto, 
  DayBookSummaryDto, 
  InterestCalculationDto,
  InterestPaymentDto 
} from './dto/daybook.dto';

@Controller('daybook')
export class DayBookController {
  private readonly logger = new Logger(DayBookController.name);

  constructor(private readonly dayBookService: DayBookService) {}

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

  @Get('report/sb')
  async getDayBookSBReport(@Query() dto: GetDayBookDto): Promise<{
    success: boolean;
    data: DayBookSummaryDto;
    message: string;
  }> {
    this.logger.log(`Generating day book SB report for date: ${dto.date}`);
    
    // Force SB filtering
    const sbDto = { ...dto, filterType: 'sb' as const };
    const report = await this.dayBookService.getDayBookReport(sbDto);
    
    return {
      success: true,
      data: report,
      message: 'Day book SB report generated successfully'
    };
  }

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