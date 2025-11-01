import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { LoanService } from './loan.service';
import { InterestCalculationService, DefaulterTrackingService, PaymentProcessingService } from './services';
import {
  CreateLoanDto,
  UpdateLoanDto,
  LoanResponseDto,
  CreateLoanPaymentDto,
  PaymentResponseDto,
} from './dto';

@ApiTags('Loans')
@Controller('loans')
@ApiBearerAuth()
export class LoanController {
  constructor(
    private readonly loanService: LoanService,
    private readonly interestCalculationService: InterestCalculationService,
    private readonly defaulterTrackingService: DefaulterTrackingService,
    private readonly paymentProcessingService: PaymentProcessingService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new loan application' })
  @ApiResponse({
    status: 201,
    description: 'Loan application created successfully',
    type: LoanResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad request - validation failed' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  @ApiResponse({ status: 409, description: 'Conflict - duplicate loan account' })
  async create(@Body() createLoanDto: CreateLoanDto): Promise<LoanResponseDto> {
    return this.loanService.create(createLoanDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all loans with search and pagination' })
  @ApiResponse({
    status: 200,
    description: 'Loans retrieved successfully',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'General search term' })
  @ApiQuery({ name: 'memberId', required: false, type: Number, description: 'Filter by member ID' })
  @ApiQuery({ name: 'accountNumber', required: false, type: String, description: 'Filter by account number' })
  @ApiQuery({ name: 'loanType', required: false, type: String, description: 'Filter by loan type' })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'CLOSED', 'DEFAULTED', 'WRITTEN_OFF'], description: 'Filter by status' })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['accountNumber', 'disbursementDate', 'maturityDate', 'principalAmount', 'outstandingBalance'], description: 'Sort field' })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['ASC', 'DESC'], description: 'Sort order' })
  async findAll(@Query() query: any) {
    return this.loanService.findAll(query);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get loan statistics' })
  @ApiResponse({
    status: 200,
    description: 'Loan statistics retrieved successfully',
  })
  async getStatistics() {
    return this.loanService.getStatistics();
  }

  @Get('defaulters')
  @ApiOperation({ summary: 'Get list of defaulted loans' })
  @ApiResponse({
    status: 200,
    description: 'Defaulter list retrieved successfully',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  async getDefaulters(@Query() query: any) {
    return this.loanService.getDefaulters(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get loan by ID' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 200,
    description: 'Loan retrieved successfully',
    type: LoanResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<LoanResponseDto> {
    return this.loanService.findOne(id);
  }

  @Get('account/:accountNumber')
  @ApiOperation({ summary: 'Get loan by account number' })
  @ApiParam({ name: 'accountNumber', type: 'string', description: 'Loan account number' })
  @ApiResponse({
    status: 200,
    description: 'Loan retrieved successfully',
    type: LoanResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async findByAccountNumber(@Param('accountNumber') accountNumber: string): Promise<LoanResponseDto> {
    return this.loanService.findByAccountNumber(accountNumber);
  }

  @Get('member/:memberId')
  @ApiOperation({ summary: 'Get loans by member ID' })
  @ApiParam({ name: 'memberId', type: 'number', description: 'Member ID' })
  @ApiResponse({
    status: 200,
    description: 'Member loans retrieved successfully',
  })
  async findByMember(@Param('memberId', ParseIntPipe) memberId: number) {
    return this.loanService.findByMember(memberId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update loan by ID' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 200,
    description: 'Loan updated successfully',
    type: LoanResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad request - validation failed' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateLoanDto: UpdateLoanDto,
  ): Promise<LoanResponseDto> {
    return this.loanService.update(id, updateLoanDto);
  }

  @Post(':id/disburse')
  @ApiOperation({ summary: 'Disburse loan amount' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 200,
    description: 'Loan disbursed successfully',
    type: LoanResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Loan cannot be disbursed' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async disburse(@Param('id', ParseIntPipe) id: number): Promise<LoanResponseDto> {
    return this.loanService.disburse(id);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Close loan account' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 200,
    description: 'Loan closed successfully',
    type: LoanResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Loan cannot be closed' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async close(@Param('id', ParseIntPipe) id: number): Promise<LoanResponseDto> {
    return this.loanService.close(id);
  }

  @Post(':id/payments')
  @ApiOperation({ summary: 'Record loan payment with automatic breakdown' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 201,
    description: 'Payment recorded successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request - validation failed' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async recordPayment(
    @Param('id', ParseIntPipe) id: number,
    @Body() createPaymentDto: CreateLoanPaymentDto,
  ) {
    return this.paymentProcessingService.processPayment(id, createPaymentDto);
  }

  @Post(':id/payments/partial')
  @ApiOperation({ summary: 'Record partial payment with custom breakdown' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 201,
    description: 'Partial payment recorded successfully',
  })
  async recordPartialPayment(
    @Param('id', ParseIntPipe) id: number,
    @Body() paymentDto: CreateLoanPaymentDto & {
      customBreakdown?: {
        principalAmount?: number;
        interestAmount?: number;
        penaltyAmount?: number;
      };
    },
  ) {
    return this.paymentProcessingService.processPartialPayment(id, paymentDto);
  }

  @Post(':id/foreclose')
  @ApiOperation({ summary: 'Process loan foreclosure (early closure)' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 200,
    description: 'Loan foreclosed successfully',
  })
  async foreclose(
    @Param('id', ParseIntPipe) id: number,
    @Body() foreclosureData: {
      paymentAmount: number;
      paymentMethod: string;
      referenceNumber?: string;
      waivePenalty?: boolean;
      remarks?: string;
    },
  ) {
    return this.paymentProcessingService.processForeclosure(id, foreclosureData);
  }

  @Post(':id/settle')
  @ApiOperation({ summary: 'Process loan settlement (partial payment to close)' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 200,
    description: 'Loan settled successfully',
  })
  async settle(
    @Param('id', ParseIntPipe) id: number,
    @Body() settlementData: {
      settlementAmount: number;
      paymentMethod: string;
      referenceNumber?: string;
      remarks?: string;
      approvedBy: string;
    },
  ) {
    return this.paymentProcessingService.processSettlement(id, settlementData);
  }

  @Get(':id/outstanding-amount')
  @ApiOperation({ summary: 'Calculate outstanding amount for loan closure' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 200,
    description: 'Outstanding amount calculated successfully',
  })
  async getOutstandingAmount(@Param('id', ParseIntPipe) id: number) {
    return this.paymentProcessingService.calculateOutstandingAmount(id);
  }

  @Get('receipts/:receiptNumber')
  @ApiOperation({ summary: 'Get payment receipt by receipt number' })
  @ApiParam({ name: 'receiptNumber', type: 'string', description: 'Receipt number' })
  @ApiResponse({
    status: 200,
    description: 'Payment receipt retrieved successfully',
  })
  async getPaymentReceipt(@Param('receiptNumber') receiptNumber: string) {
    return this.paymentProcessingService.getPaymentReceipt(receiptNumber);
  }

  @Get(':id/payments')
  @ApiOperation({ summary: 'Get loan payment history' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 200,
    description: 'Payment history retrieved successfully',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  async getPaymentHistory(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: any,
  ) {
    return this.loanService.getPaymentHistory(id, query);
  }

  @Get(':id/emi-schedule')
  @ApiOperation({ summary: 'Get loan EMI schedule' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 200,
    description: 'EMI schedule retrieved successfully',
  })
  async getEmiSchedule(@Param('id', ParseIntPipe) id: number) {
    return this.loanService.getEmiSchedule(id);
  }

  @Post(':id/calculate-interest')
  @ApiOperation({ summary: 'Calculate and post interest for loan' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 200,
    description: 'Interest calculated and posted successfully',
  })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async calculateInterest(@Param('id', ParseIntPipe) id: number) {
    return this.loanService.calculateInterest(id);
  }

  @Patch(':id/surety')
  @ApiOperation({ summary: 'Update loan surety information' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 200,
    description: 'Surety information updated successfully',
    type: LoanResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async updateSurety(
    @Param('id', ParseIntPipe) id: number,
    @Body() suretyData: { suretyName?: string; suretyPhone?: string; suretyAddress?: string },
  ): Promise<LoanResponseDto> {
    return this.loanService.updateSurety(id, suretyData);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete loan by ID' })
  @ApiParam({ name: 'id', type: 'number', description: 'Loan ID' })
  @ApiResponse({ status: 204, description: 'Loan deleted successfully' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.loanService.remove(id);
  }

  // Interest Calculation Endpoints

  @Post('calculate-all-interest')
  @ApiOperation({ summary: 'Calculate interest for all active loans' })
  @ApiResponse({
    status: 200,
    description: 'Interest calculated for all loans successfully',
  })
  async calculateAllInterest() {
    return this.interestCalculationService.calculateAllLoansInterest();
  }

  @Get('interest-rates')
  @ApiOperation({ summary: 'Get interest rate slabs' })
  @ApiResponse({
    status: 200,
    description: 'Interest rate slabs retrieved successfully',
  })
  async getInterestRates() {
    return this.interestCalculationService.getInterestRateSlabs();
  }

  @Get('interest-rate/:loanType/:amount')
  @ApiOperation({ summary: 'Get applicable interest rate for loan type and amount' })
  @ApiParam({ name: 'loanType', type: 'string', description: 'Loan type' })
  @ApiParam({ name: 'amount', type: 'number', description: 'Loan amount' })
  @ApiResponse({
    status: 200,
    description: 'Applicable interest rate retrieved successfully',
  })
  async getApplicableRate(
    @Param('loanType') loanType: string,
    @Param('amount', ParseIntPipe) amount: number,
  ) {
    const rate = this.interestCalculationService.getApplicableInterestRate(loanType, amount);
    return { loanType, amount, interestRate: rate };
  }

  @Post('calculate-emi')
  @ApiOperation({ summary: 'Calculate EMI for given parameters' })
  @ApiResponse({
    status: 200,
    description: 'EMI calculated successfully',
  })
  async calculateEMI(
    @Body() body: { principal: number; annualRate: number; tenureMonths: number },
  ) {
    const emi = this.interestCalculationService.calculateEMI(
      body.principal,
      body.annualRate,
      body.tenureMonths,
    );
    return { ...body, emi };
  }

  @Post('amortization-schedule')
  @ApiOperation({ summary: 'Generate amortization schedule' })
  @ApiResponse({
    status: 200,
    description: 'Amortization schedule generated successfully',
  })
  async generateAmortizationSchedule(
    @Body() body: { principal: number; annualRate: number; tenureMonths: number },
  ) {
    const schedule = this.interestCalculationService.generateAmortizationSchedule(
      body.principal,
      body.annualRate,
      body.tenureMonths,
    );
    return { ...body, schedule };
  }

  // Defaulter Tracking Endpoints

  @Get('defaulters/list')
  @ApiOperation({ summary: 'Get comprehensive defaulter list' })
  @ApiResponse({
    status: 200,
    description: 'Defaulter list retrieved successfully',
  })
  async getDefaulterList() {
    return this.defaulterTrackingService.getDefaulterList();
  }

  @Get('defaulters/summary')
  @ApiOperation({ summary: 'Get defaulter summary statistics' })
  @ApiResponse({
    status: 200,
    description: 'Defaulter summary retrieved successfully',
  })
  async getDefaulterSummary() {
    return this.defaulterTrackingService.getDefaulterSummary();
  }

  @Get('defaulters/category/:category')
  @ApiOperation({ summary: 'Get defaulters by category' })
  @ApiParam({ 
    name: 'category', 
    enum: ['MILD', 'MODERATE', 'SEVERE', 'CRITICAL'],
    description: 'Defaulter category' 
  })
  @ApiResponse({
    status: 200,
    description: 'Defaulters by category retrieved successfully',
  })
  async getDefaultersByCategory(
    @Param('category') category: 'MILD' | 'MODERATE' | 'SEVERE' | 'CRITICAL',
  ) {
    return this.defaulterTrackingService.getDefaultersByCategory(category);
  }

  @Get('defaulters/days-range')
  @ApiOperation({ summary: 'Get defaulters by days past due range' })
  @ApiQuery({ name: 'minDays', type: 'number', description: 'Minimum days past due' })
  @ApiQuery({ name: 'maxDays', required: false, type: 'number', description: 'Maximum days past due' })
  @ApiResponse({
    status: 200,
    description: 'Defaulters by days range retrieved successfully',
  })
  async getDefaultersByDaysRange(
    @Query('minDays', ParseIntPipe) minDays: number,
    @Query('maxDays', new ParseIntPipe({ optional: true })) maxDays?: number,
  ) {
    const maxDaysNum = maxDays;
    return this.defaulterTrackingService.getDefaultersByDaysRange(minDays, maxDaysNum);
  }

  @Post('defaulters/mark-defaulted')
  @ApiOperation({ summary: 'Mark loans as defaulted based on days past due' })
  @ApiResponse({
    status: 200,
    description: 'Loans marked as defaulted successfully',
  })
  async markLoansAsDefaulted(
    @Body() body: { daysPastDue?: number },
  ) {
    return this.defaulterTrackingService.markLoansAsDefaulted(body.daysPastDue);
  }

  @Post('defaulters/report')
  @ApiOperation({ summary: 'Generate defaulter report for period' })
  @ApiResponse({
    status: 200,
    description: 'Defaulter report generated successfully',
  })
  async generateDefaulterReport(
    @Body() body: { fromDate: string; toDate: string },
  ) {
    return this.defaulterTrackingService.generateDefaulterReport(
      new Date(body.fromDate),
      new Date(body.toDate),
    );
  }

  @Get('defaulters/:loanId/recovery-suggestions')
  @ApiOperation({ summary: 'Get recovery suggestions for a defaulter' })
  @ApiParam({ name: 'loanId', type: 'number', description: 'Loan ID' })
  @ApiResponse({
    status: 200,
    description: 'Recovery suggestions retrieved successfully',
  })
  async getRecoverySuggestions(@Param('loanId', ParseIntPipe) loanId: number) {
    return this.defaulterTrackingService.getRecoverySuggestions(loanId);
  }
}
