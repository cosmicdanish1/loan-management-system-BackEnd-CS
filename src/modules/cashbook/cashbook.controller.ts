import { Controller, Get, Post, Body, Query, Logger } from '@nestjs/common';
import { CashBookService } from './cashbook.service';
import { 
  GetCashBookDto, 
  CashBookSummaryDto,
  CreateTransactionDto 
} from './dto/cashbook.dto';

@Controller('cashbook')
export class CashBookController {
  private readonly logger = new Logger(CashBookController.name);

  constructor(private readonly cashBookService: CashBookService) {}

  @Get('report')
  async getCashBookReport(@Query() dto: GetCashBookDto): Promise<{
    success: boolean;
    data: CashBookSummaryDto;
    message: string;
  }> {
    try {
      this.logger.log(`Generating cash book report for date: ${dto.date}`);
      
      const report = await this.cashBookService.getCashBookReport(dto);
      
      return {
        success: true,
        data: report,
        message: 'Cash book report generated successfully'
      };
    } catch (error) {
      this.logger.error('Error generating cash book report:', error);
      return {
        success: false,
        data: null,
        message: error.message || 'Failed to generate cash book report'
      };
    }
  }

  @Post('transaction')
  async createTransaction(@Body() dto: CreateTransactionDto): Promise<{
    success: boolean;
    data: any;
    message: string;
  }> {
    try {
      this.logger.log(`Creating transaction: ${dto.transType} - ${dto.headName}`);
      
      const transaction = await this.cashBookService.createTransaction(dto);
      
      return {
        success: true,
        data: transaction,
        message: 'Transaction created successfully'
      };
    } catch (error) {
      this.logger.error('Error creating transaction:', error);
      return {
        success: false,
        data: null,
        message: error.message || 'Failed to create transaction'
      };
    }
  }

  @Get('members/active')
  async getActiveMembers(): Promise<{
    success: boolean;
    data: any[];
    message: string;
  }> {
    try {
      const members = await this.cashBookService.getActiveMembers();
      
      return {
        success: true,
        data: members,
        message: 'Active members fetched successfully'
      };
    } catch (error) {
      this.logger.error('Error fetching active members:', error);
      return {
        success: false,
        data: [],
        message: error.message || 'Failed to fetch active members'
      };
    }
  }

  @Get('interest-rate')
  async getCurrentInterestRate(): Promise<{
    success: boolean;
    data: { rate: number };
    message: string;
  }> {
    try {
      const rate = await this.cashBookService.getCurrentInterestRate();
      
      return {
        success: true,
        data: { rate },
        message: 'Interest rate fetched successfully'
      };
    } catch (error) {
      this.logger.error('Error fetching interest rate:', error);
      return {
        success: false,
        data: { rate: 4.0 },
        message: error.message || 'Failed to fetch interest rate'
      };
    }
  }

  @Get('member/balance')
  async getMemberBalance(@Query('memberCode') memberCode: string): Promise<{
    success: boolean;
    data: { balance: number };
    message: string;
  }> {
    try {
      const balance = await this.cashBookService.getMemberBalance(memberCode);
      
      return {
        success: true,
        data: { balance },
        message: 'Member balance fetched successfully'
      };
    } catch (error) {
      this.logger.error('Error fetching member balance:', error);
      return {
        success: false,
        data: { balance: 0 },
        message: error.message || 'Failed to fetch member balance'
      };
    }
  }

  @Get('transactions')
  async getTransactionsByDateRange(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string
  ): Promise<{
    success: boolean;
    data: any[];
    message: string;
  }> {
    try {
      const transactions = await this.cashBookService.getTransactionsByDateRange(startDate, endDate);
      
      return {
        success: true,
        data: transactions,
        message: 'Transactions fetched successfully'
      };
    } catch (error) {
      this.logger.error('Error fetching transactions:', error);
      return {
        success: false,
        data: [],
        message: error.message || 'Failed to fetch transactions'
      };
    }
  }
}