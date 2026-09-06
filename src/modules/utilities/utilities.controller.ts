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

@ApiTags('Utilities')
@Controller('utilities')
export class UtilitiesController {
  private readonly logger = new Logger(UtilitiesController.name);

  constructor(private readonly utilitiesService: UtilitiesService) { }

  @Get('head-balance/:code')
  @ApiOperation({ summary: 'Get the running ledger balance for an account head (e.g. a bank/cash account)' })
  async getHeadBalance(@Param('code') code: string) {
    const balance = await this.utilitiesService.getHeadBalance(code);
    return { success: true, data: { code, balance } };
  }

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

  @Get('rd-accounts/holders')
  @ApiOperation({ summary: 'List members who have at least one active RD account (for Premature Information dropdown)' })
  async listRdAccountHolders() {
    const data = await this.utilitiesService.listRdAccountHolders();
    return { success: true, data, message: 'RD account holders retrieved successfully' };
  }

  @Get('sb-accounts/holders')
  @ApiOperation({ summary: 'List members who have an SB account (for Premature Information dropdown)' })
  async listSbAccountHolders() {
    const data = await this.utilitiesService.listSbAccountHolders();
    return { success: true, data, message: 'SB account holders retrieved successfully' };
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
    // 4.4 fix: missing fields crashed with 500 "null value in column ..." —
    // confirmed live.
    if (!body?.fromAccount || !body?.toAccount || typeof body?.amount !== 'number' || !body?.transferDate) {
      throw new BadRequestException('fromAccount, toAccount, amount, and transferDate are required');
    }
    const username = req.user?.susername || req.user?.username || 'system';
    const result = await this.utilitiesService.processBalanceTransfer(body, username);
    return result;
  }

  @Get('head-master')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get all account heads from headmaster with balance sheet data' })
  async getHeadMaster() {
    return await this.utilitiesService.getHeadMaster();
  }

  @Get('divisions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get all divisions from division_master' })
  async getDivisions() {
    const data = await this.utilitiesService.getDivisions();
    return { success: true, data };
  }

  @Post('saving/transaction')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save SB transaction to ledger (acc_type=SB)' })
  async saveSavingTransaction(@Body() body: any, @Req() req: any) {
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[SavingTxn] POST member=${body.memberNo} type=${body.transType} amount=${body.amount} by ${username}`);
    const result = await this.utilitiesService.saveSavingTransaction(body, username);
    return result;
  }

  @Get('saving/account/:accountNo')
  @UseGuards(JwtAuthGuard)
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
    // BUG FIX: manually wrapped in {success, data} on top of the global
    // TransformInterceptor's identical wrap — same double-wrap pattern already
    // fixed for business-rules/demand-print-order/deposit-loan-slabs/
    // getPendingDividends this session; this was one of the ones flagged but
    // not yet fixed until this screen was directly in scope.
    return await this.utilitiesService.getFdAccountsByMember(memberNo);
  }

  @Post('fd-interest/post')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Post FD interest voucher (accrual) — CR A003/FD, vchr_type=J' })
  async postFdInterestVoucher(@Body() body: any, @Req() req: any) {
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[FDInterest] POST FD=${body.accountNumber} amount=${body.interestAmount} by ${username}`);
    const result = await this.utilitiesService.postFdInterestVoucher(body, username);
    return result;
  }

  @Post('fd-interest/pay')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Pay FD interest out to member — DR A003/FD, CR cash/bank, vchr_type=P' })
  async payFdInterest(@Body() body: any, @Req() req: any) {
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[FDInterest] PAY OUT FD=${body.accountNumber} amount=${body.interestAmount} by ${username}`);
    const result = await this.utilitiesService.payFdInterest(body, username);
    return result;
  }

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
    // BUG FIX: manually wrapped in {success, data} on top of the global
    // TransformInterceptor's identical wrap — same pattern already fixed for
    // business-rules/demand-print-order/deposit-loan-slabs this session.
    return await this.utilitiesService.getPendingDividends(memberNo);
  }

  @Post('dividend/pay')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Process dividend payment — DR L1024, update dividend_master' })
  async processDividendPayment(@Body() body: any, @Req() req: any) {
    // 4.4 fix: missing fields crashed with 500 "null value in column ..." —
    // confirmed live.
    if (!body?.memberNo || typeof body?.totalAmount !== 'number') {
      throw new BadRequestException('memberNo and a numeric totalAmount are required');
    }
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[Dividend] POST pay member=${body.memberNo} amount=${body.totalAmount} by ${username}`);
    const result = await this.utilitiesService.processDividendPayment(body, username);
    return result;
  }

  @Post('receipt')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save receipt: CR rows (vchr_type=R) + DR bank (vchr_type=P), same R_VCHR_NO' })
  async saveReceipt(@Body() body: any, @Req() req: any) {
    // 4.4 fix: a missing rows array crashed with 500 "Cannot read properties
    // of undefined (reading 'length')" — confirmed live.
    if (!body?.memberNo || !Array.isArray(body?.rows) || body.rows.length === 0) {
      throw new BadRequestException('memberNo and a non-empty rows array are required');
    }
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[Receipt] POST member=${body.memberNo} rows=${body.rows?.length} by ${username}`);
    const result = await this.utilitiesService.saveReceipt(body, username);
    return result;
  }

  @Post('receipt-voucher')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save receipt voucher to ledger (vchr_type=R, DR CINH + CR rows)' })
  async saveReceiptVoucher(@Body() body: any, @Req() req: any) {
    // 4.4 fix: a missing rows array crashed with 500 "Cannot read properties
    // of undefined (reading 'length')" — confirmed live.
    if (!body?.memberNo || !Array.isArray(body?.rows) || body.rows.length === 0) {
      throw new BadRequestException('memberNo and a non-empty rows array are required');
    }
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[VoucherPayment] POST member=${body.memberNo} rows=${body.rows?.length} by ${username}`);
    const result = await this.utilitiesService.saveReceiptVoucher(body, username);
    return result;
  }

  @Post('payment-voucher')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save payment voucher to ledger (vchr_type=P, acc_type=BANK)' })
  async savePaymentVoucher(@Body() body: any, @Req() req: any) {
    // BUG FIX: missing memberNo/rows previously succeeded silently, writing an
    // orphaned voucher+transactions pair with memberId/mbno = null into the
    // PENDING queue — confirmed live. Same guard pattern as the sibling
    // receipt/receipt-voucher/dividend-pay endpoints just above.
    if (!body?.memberNo || !Array.isArray(body?.rows) || body.rows.length === 0) {
      throw new BadRequestException('memberNo and a non-empty rows array are required');
    }
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[PaymentVoucher] POST member=${body.memberNo} rows=${body.rows?.length} by ${username}`);
    const result = await this.utilitiesService.savePaymentVoucher(body, username);
    return result;
  }

  @Post('loan/entry')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save loan entry to loan_master and suretymaster' })
  async saveLoanEntry(@Body() body: any, @Req() req: any) {
    // 4.4 fix: missing fields crashed with 500 "Cannot read properties of
    // undefined (reading 'toString')" — confirmed live.
    if (!body?.loanType || !body?.memberNo) {
      throw new BadRequestException('loanType and memberNo are required');
    }
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[LoanEntry] POST loan type=${body.loanType} member=${body.memberNo} by ${username}`);
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

  @Post('fd-rd-sb/entry')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save FD/RD/SB ledger entry' })
  async saveFdRdSbEntry(@Body() body: any, @Req() req: any) {
    // 4.4 fix: missing fields crashed with 500 "null value in column ..." —
    // confirmed live.
    if (!body?.entryType || !body?.memberNo) {
      throw new BadRequestException('entryType and memberNo are required');
    }
    const username = req.user?.susername || req.user?.username || 'system';
    this.logger.log(`[FdRdSbEntry] POST entry type=${body.entryType} member=${body.memberNo} by ${username}`);
    const result = await this.utilitiesService.saveFdRdSbEntry(body, username);
    return result;
  }

  @Post('head-master/rebuild-tree')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Rebuild balancesheet from ledger transactions (like legacy Build Tree)' })
  async rebuildBalancesheet() {
    const result = await this.utilitiesService.rebuildBalancesheet();
    return result;
  }

  @Post('head-master')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Add or update an account head in headmaster' })
  async saveHeadMaster(@Body() body: any) {
    const result = await this.utilitiesService.saveHeadMaster(body);
    return result;
  }

  @Delete('head-master/:code')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Delete an account head (blocked if it has children)' })
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

  @Post('head-opening-balance/apply/:yearcode')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Apply year opening balances to headmaster.op_bal' })
  async applyYearOpeningBalances(@Param('yearcode') yearcode: string) {
    return await this.utilitiesService.applyYearOpeningBalances(parseInt(yearcode));
  }

  @Post('head-opening-balance')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save head opening balances for a financial year' })
  async saveHeadOpeningBalances(@Body() body: { yearcode: number; balances: Array<{ headCode: string; closingBal: number }> }) {
    // 4.4 fix: a missing balances array crashed with 500 "balances is not
    // iterable" — confirmed live.
    if (!body?.yearcode || !Array.isArray(body?.balances)) {
      throw new BadRequestException('yearcode and a balances array are required');
    }
    return await this.utilitiesService.saveHeadOpeningBalances(body.yearcode, body.balances);
  }

  @Get('deposit-loan-slabs')  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get deposit/loan interest slabs from fdrd_slab_details' })
  async getDepositLoanSlabs(@Query('type') type?: string) {
    // BUG FIX: this manually wrapped the payload in {success, data}, but the
    // global TransformInterceptor already wraps every response the same way —
    // callers were getting data.data instead of data. Same pattern already
    // fixed for business-rules/demand-print-order.
    return await this.utilitiesService.getDepositLoanSlabs(type);
  }

  @Post('deposit-loan-slabs')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save deposit/loan interest slabs to fdrd_slab_details' })
  async saveDepositLoanSlabs(@Body() body: { rows: any[]; type: string }) {
    // 4.4 fix: a missing type crashed with 500 "Cannot read properties of
    // undefined (reading 'toUpperCase')" — confirmed live.
    if (!Array.isArray(body?.rows) || !body?.type) {
      throw new BadRequestException('rows (array) and type are required');
    }
    const result = await this.utilitiesService.saveDepositLoanSlabs(body.rows, body.type);
    return result;
  }

  @Get('demand-print-order')  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get demand print order configuration' })
  async getDemandPrintOrder() {
    // BUG FIX: this manually wrapped the payload in {success, data}, but the
    // global TransformInterceptor wraps every controller response the same
    // way — double-wrapping meant the frontend's response.data was actually
    // {success, data:[...]} instead of the array directly.
    return await this.utilitiesService.getDemandPrintOrder();
  }

  @Post('demand-print-order')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Save demand print order configuration' })
  async saveDemandPrintOrder(@Body() body: { rows: any[] }) {
    // 4.4 fix: a missing rows array crashed with 500 "rows is not iterable" —
    // confirmed live.
    if (!Array.isArray(body?.rows)) {
      throw new BadRequestException('rows must be an array');
    }
    const result = await this.utilitiesService.saveDemandPrintOrder(body.rows);
    return result;
  }

  @Get('business-rules')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get current business rules from busrules table' })
  async getBusinessRules() {
    // BUG FIX: same double-wrap as getDemandPrintOrder above — the manual
    // {success, data} wrapper here, stacked on top of the global
    // TransformInterceptor's identical wrapping, meant useBusinessRules.ts's
    // `response.data.RULE_...` reads were always undefined. Every field
    // silently fell back to the hardcoded initialData defaults on every load,
    // never showing (or letting you build on top of) what was actually saved.
    return await this.utilitiesService.getBusinessRules();
  }

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

  // BUG FIX: same double-wrap pattern already fixed elsewhere in this
  // controller (deposit-loan-slabs, demand-print-order, business-rules) — the
  // global TransformInterceptor already wraps every response in {success,
  // data}, so this manual wrapper wrapped it twice.
  @Get('financial-year/current')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get the current (latest) financial year' })
  async getCurrentFinancialYear() {
    return await this.utilitiesService.getCurrentFinancialYear();
  }

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
