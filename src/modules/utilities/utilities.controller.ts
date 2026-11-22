import { BadRequestException, Controller, Get, Post, Patch, Delete, Body, Query, Param, Logger, UseGuards, Req } from '@nestjs/common';
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
import { RequireMenuAction } from '../auth/guards/menu-right.guard';
import { RoleGuard } from '../auth/guards/role.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';
import { SbEnabledGuard } from '../shared/utils/sb-feature';

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
  @UseGuards(SbEnabledGuard)
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
  @UseGuards(JwtAuthGuard, RoleGuard) // ES-298: global settings are administrator-only
  @Roles(UserRole.ADMIN)
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

  @RequireMenuAction('MEMBER_BALANCE_TRANSFER', 'MODIFY_MEMBER_BAL') // ES-464
  @Post('balance-transfer')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Process a manual balance transfer between accounts' })
  async processBalanceTransfer(
    @Body() body: {
      fromAccount: string;
      toAccount: string;
      amount: number;
      transferDate: string;
      description: string;
    },
    @Req() req: any,
  ) {
    const username = req.user?.susername || req.user?.username || 'system';
    const result = await this.utilitiesService.processBalanceTransfer(body, username);
    return result;
  }

  @Get('head-master')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get all account heads from headmaster with balance sheet data' })
  async getHeadMaster() {
    const data = await this.utilitiesService.getHeadMaster();
    return { success: true, data };
  }

  @Get('divisions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get all divisions from division_master' })
  async getDivisions() {
    const data = await this.utilitiesService.getDivisions();
    return { success: true, data };
  }

  @RequireMenuAction('SAVING_RECEIPT_PAYMENT') // ES-464
  @Post('saving/transaction')
  @UseGuards(SbEnabledGuard, JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save SB transaction to ledger (acc_type=SB)' })
  async saveSavingTransaction(@Body() body: any, @Req() req: any) {
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[SavingTxn] POST member=${body.memberNo} type=${body.transType} amount=${body.amount} by ${username}`);
    const result = await this.utilitiesService.saveSavingTransaction(body, username);
    return result;
  }

  @Get('saving/account/:accountNo')
  @UseGuards(SbEnabledGuard, JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get saving account details and transaction history' })
  async getSavingAccountDetails(@Param('accountNo') accountNo: string) {
    this.logger.log(`[SavingAccount] GET account details for: ${accountNo}`);
    const result = await this.utilitiesService.getSavingAccountDetails(accountNo);
    return result;
  }

  @Get('fd-accounts/member')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get active FD accounts for a member' })
  async getFdAccountsByMember(@Query('memberNo') memberNo: string) {
    this.logger.log(`[FDInterest] GET FD accounts for member: ${memberNo}`);
    const data = await this.utilitiesService.getFdAccountsByMember(memberNo);
    return { success: true, data };
  }

  @RequireMenuAction('FD_INTEREST_VOUCHER_POSTING') // ES-464
  @Post('fd-interest/post')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Post FD interest voucher — CR A003/FD, vchr_type=J' })
  async postFdInterestVoucher(@Body() body: any, @Req() req: any) {
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[FDInterest] POST FD=${body.accountNumber} amount=${body.interestAmount} by ${username}`);
    const result = await this.utilitiesService.postFdInterestVoucher(body, username);
    return result;
  }

  @RequireMenuAction('FD_RECEIPT') // ES-464
  @Post('fd-receipt')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create FD receipt — inserts into fdmaster + ledger (CR A003/FD)' })
  async createFdReceipt(@Body() body: any, @Req() req: any) {
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[FDReceipt] POST member=${body.memberNo} amount=${body.depositAmount} by ${username}`);
    const result = await this.utilitiesService.createFixedDepositReceipt(body, username);
    return result;
  }

  @Get('dividend/pending')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get pending dividends for a member' })
  async getPendingDividends(@Query('memberNo') memberNo: string) {
    this.logger.log(`[Dividend] GET pending for member: ${memberNo}`);
    const data = await this.utilitiesService.getPendingDividends(memberNo);
    return { success: true, data };
  }

  @RequireMenuAction('RECEIPT_DIVIDEND_PAYMENT') // ES-464
  @Post('dividend/pay')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Process dividend payment — DR L1024, update dividend_master' })
  async processDividendPayment(@Body() body: any, @Req() req: any) {
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[Dividend] POST pay member=${body.memberNo} amount=${body.totalAmount} by ${username}`);
    const result = await this.utilitiesService.processDividendPayment(body, username);
    return result;
  }

  @RequireMenuAction('RECEIPT_PAYMENT') // ES-464
  @Post('receipt')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Stage a receipt (pending pass): CR rows + DR cash/bank; it reaches the ledger when passed in Pass Transactions' })
  async saveReceipt(@Body() body: any, @Req() req: any) {
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[Receipt] POST member=${body.memberNo} rows=${body.rows?.length} by ${username}`);
    await this.utilitiesService.assertVoucherInput(body);
    const result = await this.utilitiesService.saveReceipt(body, username);
    return result;
  }

  @RequireMenuAction('RECEIPT_PAYMENT_VOUCHER_CREATION', 'RECEIPT_PAYMENT') // ES-464
  @Post('receipt-voucher')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save receipt voucher to ledger (vchr_type=R, DR CINH + CR rows)' })
  async saveReceiptVoucher(@Body() body: any, @Req() req: any) {
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[VoucherPayment] POST member=${body.memberNo} rows=${body.rows?.length} by ${username}`);
    await this.utilitiesService.assertVoucherInput(body);
    const result = await this.utilitiesService.saveReceiptVoucher(body, username);
    return result;
  }

  @RequireMenuAction('RECEIPT_PAYMENT_VOUCHER_CREATION', 'VOUCHER_PAYMENT') // ES-464
  @Post('payment-voucher')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Stage a payment voucher (pending pass); it reaches the ledger when passed in Pass Transactions' })
  async savePaymentVoucher(@Body() body: any, @Req() req: any) {
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[PaymentVoucher] POST member=${body.memberNo} rows=${body.rows?.length} by ${username}`);
    await this.utilitiesService.assertVoucherInput(body);
    const result = await this.utilitiesService.savePaymentVoucher(body, username);
    return result;
  }

  @Get('posting-date')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: "The date a window puts on its entries now (its Date setting: Day-End working date, or the real date)" })
  async getPostingDate(@Query('window') windowKey: string) {
    return this.utilitiesService.getPostingDate(windowKey);
  }

  @Get('working-date')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'The Day-End working date (the day vouchers are dated on); null when Day-End was never set up' })
  async getWorkingDate() {
    return this.utilitiesService.getWorkingDate();
  }

  @RequireMenuAction('VOUCHER_PAYMENT') // ES-612
  @Get('payment-vouchers/unsigned')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Voucher Payment drop-down: payment vouchers waiting to be completed in Voucher Payment' })
  async listUnsignedPaymentVouchers() {
    return this.utilitiesService.listUnsignedPaymentVouchers();
  }

  @RequireMenuAction('VOUCHER_PAYMENT') // ES-612
  @Get('payment-voucher/:voucherNo')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'One unsigned payment voucher: member, heads and amounts' })
  async getPaymentVoucherForSign(@Param('voucherNo') voucherNo: string) {
    return this.utilitiesService.getPaymentVoucherForSign(voucherNo);
  }

  @RequireMenuAction('VOUCHER_PAYMENT') // ES-612
  @Post('payment-voucher/save')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Voucher Payment Save: choose cash / bank, adds the balancing line; the voucher can then be passed in Pass Transactions' })
  async signPaymentVoucher(@Body() body: any, @Req() req: any) {
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[PaymentVoucher] SAVE ${body?.voucherNo} mode=${body?.modeOfPay} by ${username}`);
    return this.utilitiesService.signPaymentVoucher(body, username);
  }

  @RequireMenuAction('LOAN_ENTRY', 'LOAN_PAYMENT') // ES-464
  @Post('loan/entry')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save loan entry to loan_master and suretymaster' })
  async saveLoanEntry(@Body() body: any, @Req() req: any) {
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[LoanEntry] POST loan type=${body.loanType} member=${body.memberNo} by ${username}`);
    await this.utilitiesService.assertLoanEntryInput(body);
    const result = await this.utilitiesService.saveLoanEntry(body, username);
    return result;
  }

  @Get('fd-rd-sb/accounts')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get FD/RD/SB accounts for a member' })
  async getFdRdSbAccounts(
    @Query('memberNo') memberNo: string,
    @Query('type') type: string,
  ) {
    this.logger.log(`[FdRdSbEntry] GET accounts memberNo=${memberNo} type=${type}`);
    const data = await this.utilitiesService.getFdRdSbAccounts(
      parseInt(memberNo),
      type as 'FD' | 'RD' | 'SB'
    );
    return { success: true, data };
  }

  @RequireMenuAction('FD_RD_SB_ENTRY') // ES-464
  @Post('fd-rd-sb/entry')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save FD/RD/SB ledger entry' })
  async saveFdRdSbEntry(@Body() body: any, @Req() req: any) {
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[FdRdSbEntry] POST entry type=${body.entryType} member=${body.memberNo} by ${username}`);
    const result = await this.utilitiesService.saveFdRdSbEntry(body, username);
    return result;
  }

  @RequireMenuAction('HEAD_ADD_MOD') // ES-464
  @Post('head-master')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Add or update an account head in headmaster' })
  async saveHeadMaster(@Body() body: any) {
    const result = await this.utilitiesService.saveHeadMaster(body);
    return result;
  }

  @RequireMenuAction('HEAD_ADD_MOD') // ES-464
  @Post('head-master/rebuild-tree')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Build Tree: refresh the stored head balances (balancesheet) from the ledger' })
  async rebuildBalancesheet() {
    return this.utilitiesService.rebuildBalancesheet();
  }

  // ── ES-54: routes removed by commit 2cfd3e7 but still called by the app; restored from 2cfd3e7^ ──

  @Get('head-balance/:code')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get the running ledger balance for an account head (e.g. a bank/cash account)' })
  async getHeadBalance(@Param('code') code: string) {
    const balance = await this.utilitiesService.getHeadBalance(code);
    return { success: true, data: { code, balance } };
  }

  @Get('rd-accounts/holders')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'List members who have at least one active RD account (for Premature Information dropdown)' })
  async listRdAccountHolders() {
    const data = await this.utilitiesService.listRdAccountHolders();
    return { success: true, data, message: 'RD account holders retrieved successfully' };
  }

  @Get('sb-accounts/holders')
  @UseGuards(SbEnabledGuard, JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'List members who have an SB account (for Premature Information dropdown)' })
  async listSbAccountHolders() {
    const data = await this.utilitiesService.listSbAccountHolders();
    return { success: true, data, message: 'SB account holders retrieved successfully' };
  }

  @RequireMenuAction('HEAD_ADD_MOD') // ES-464
  @Delete('head-master/:code')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Delete an account head (blocked if it has children or ledger postings)' })
  async deleteHeadMaster(@Param('code') code: string) {
    return await this.utilitiesService.deleteHeadMaster(code);
  }

  @Get('financial-years')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get distinct financial years from yearend table' })
  async getFinancialYears() {
    return await this.utilitiesService.getFinancialYears();
  }

  @Get('head-opening-balance')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get head opening balances for a financial year' })
  async getHeadOpeningBalances(@Query('yearcode') yearcode: string) {
    return await this.utilitiesService.getHeadOpeningBalances(parseInt(yearcode));
  }

  @RequireMenuAction('HEAD_OPEN_BAL') // ES-464
  @Post('head-opening-balance/apply/:yearcode')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Apply year opening balances to headmaster.op_bal' })
  async applyYearOpeningBalances(@Param('yearcode') yearcode: string) {
    return await this.utilitiesService.applyYearOpeningBalances(parseInt(yearcode));
  }

  @RequireMenuAction('HEAD_OPEN_BAL') // ES-464
  @Post('head-opening-balance')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save head opening balances for a financial year' })
  async saveHeadOpeningBalances(@Body() body: { yearcode: number; balances: Array<{ headCode: string; closingBal: number }> }) {
    // A missing balances array crashed with 500 "balances is not iterable".
    if (!body?.yearcode || !Array.isArray(body?.balances)) {
      throw new BadRequestException('yearcode and a balances array are required');
    }
    return await this.utilitiesService.saveHeadOpeningBalances(body.yearcode, body.balances);
  }

  @Get('deposit-loan-slabs')  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get deposit/loan interest slabs from fdrd_slab_details' })
  async getDepositLoanSlabs(@Query('type') type?: string) {
    const data = await this.utilitiesService.getDepositLoanSlabs(type);
    return { success: true, data };
  }

  @RequireMenuAction('DEPOSIT_LOAN_SLAB') // ES-464
  @Post('deposit-loan-slabs')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save deposit/loan interest slabs to fdrd_slab_details' })
  async saveDepositLoanSlabs(@Body() body: { rows: any[]; type: string }) {
    const result = await this.utilitiesService.saveDepositLoanSlabs(body.rows, body.type);
    return result;
  }

  @Get('demand-print-order')  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get demand print order configuration' })
  async getDemandPrintOrder() {
    const data = await this.utilitiesService.getDemandPrintOrder();
    return { success: true, data };
  }

  @RequireMenuAction('DEMAND_PRINT_ORDER') // ES-464
  @Post('demand-print-order')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save demand print order configuration' })
  async saveDemandPrintOrder(@Body() body: { rows: any[] }) {
    const result = await this.utilitiesService.saveDemandPrintOrder(body.rows);
    return result;
  }

  @Get('business-rules')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get current business rules from busrules table' })
  async getBusinessRules() {
    // No manual {success,data} wrapper -- the global TransformInterceptor
    // already wraps every controller's return value in
    // {success,statusCode,message,data,timestamp}. Wrapping again here
    // double-nested the payload one level too deep for the frontend's
    // single-level unwrap — confirmed live: every saved business rule was
    // invisible on reload, the whole screen always silently fell back to
    // hardcoded defaults regardless of what was actually saved.
    return this.utilitiesService.getBusinessRules();
  }

  @RequireMenuAction('MODIFY_BIZ_RULES')
  @Post('business-rules')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save business rules to busrules table' })
  async updateBusinessRules(
    @Body() body: Record<string, any>,
    @Req() req: any,
  ) {
    const result = await this.utilitiesService.updateBusinessRules(body);
    return result;
  }

  // ─── Financial Year ───────────────────────────────────────────────────────

  @Get('financial-year/current')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get the current (latest) financial year' })
  async getCurrentFinancialYear() {
    const data = await this.utilitiesService.getCurrentFinancialYear();
    return { success: true, data };
  }

  @RequireMenuAction('FIN_YEAR_TRANSFER') // ES-464
  @Post('financial-year/transfer-entries')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Transfer entries for financial year closing' })
  async transferEntriesForClosing(
    @Body('yearCode') yearCode: number,
    @Req() req: any,
  ) {
    const username = req.user?.susername || req.user?.username || 'system';
    const result = await this.utilitiesService.transferEntriesForClosing(yearCode, username);
    return result;
  }
}
