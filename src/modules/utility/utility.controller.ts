import { 
  Controller, 
  Get, 
  Post, 
  Query, 
  Body, 
  Param, 
  ParseIntPipe,
  UseGuards 
} from '@nestjs/common';
import { 
  ApiTags, 
  ApiOperation, 
  ApiResponse, 
  ApiBearerAuth,
  ApiQuery 
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UtilityService } from './utility.service';
import { SearchService } from './services/search.service';
import { BalanceService } from './services/balance.service';
// import { InterestRateUpdateService } from './services/interest-rate-update.service';
import { DataConsistencyService } from './services/data-consistency.service';
import { DataCorrectionService } from './services/data-correction.service';
import { SystemHealthMonitoringService } from './services/system-health-monitoring.service';
import { 
  SearchFiltersDto, 
  GlobalSearchDto, 
  SearchResult, 
  GlobalSearchResult 
} from './dto/search.dto';
import { 
  MemberBalanceInquiryDto, 
  AccountStatementDto, 
  MemberBalance, 
  AccountBalance, 
  AccountStatement 
} from './dto/balance.dto';
import {
  InterestRateUpdateDto,
  BulkInterestRateUpdateDto,
  RecalculateInterestDto,
  OrphanedRecordFixDto,
  BalanceCorrectionRequestDto,
  RemoveDuplicatesDto,
  InterestRateUpdateResultDto,
  CorrectionResultDto,
  BulkCorrectionResultDto,
  SystemHealthMetricsDto,
  HealthAlertDto,
  PerformanceMetricsDto,
} from './dto/data-maintenance.dto';

@ApiTags('Utilities')
@Controller('utilities')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UtilityController {
  constructor(
    private readonly utilityService: UtilityService,
    private readonly searchService: SearchService,
    private readonly balanceService: BalanceService,
    // private readonly interestRateUpdateService: InterestRateUpdateService,
    private readonly dataConsistencyService: DataConsistencyService,
    private readonly dataCorrectionService: DataCorrectionService,
    private readonly systemHealthMonitoringService: SystemHealthMonitoringService,
  ) {}

  // Search Endpoints
  @Get('search/global')
  @ApiOperation({ summary: 'Global search across all entities' })
  @ApiResponse({ status: 200, description: 'Search results returned successfully' })
  async globalSearch(@Query() searchDto: GlobalSearchDto): Promise<GlobalSearchResult> {
    return this.searchService.globalSearch(searchDto);
  }

  @Get('search/members')
  @ApiOperation({ summary: 'Search members with filters' })
  @ApiResponse({ status: 200, description: 'Member search results returned successfully' })
  async searchMembers(@Query() filters: SearchFiltersDto): Promise<SearchResult<any>> {
    return this.searchService.searchMembers(filters);
  }

  @Get('search/loans')
  @ApiOperation({ summary: 'Search loan accounts with filters' })
  @ApiResponse({ status: 200, description: 'Loan search results returned successfully' })
  async searchLoans(@Query() filters: SearchFiltersDto): Promise<SearchResult<any>> {
    return this.searchService.searchLoans(filters);
  }

  // BUG FIX 48: this route collided with utilities.controller.ts's own, unrelated
  // 'search/deposits' (both controllers are @Controller('utilities'), and this
  // module is imported first in app.module.ts, so this guarded handler silently
  // won every request — confirmed live, a curl with no token returned 401 from
  // here instead of reaching the intended handler at all). The RD Premature
  // Information screen (and getRDAccounts/searchRDAccounts in api.ts) was built
  // against the OTHER controller's shape (query param `memberNo`+`type`, not this
  // one's `memberNumber`-only SearchFiltersDto with forbidNonWhitelisted=true) —
  // so every real call from that screen was failing outright (401, or 400 once
  // authenticated, since memberNo/type aren't recognized DTO properties). Renamed
  // this one out of the way; nothing in the frontend calls this specific route
  // (confirmed via full-repo grep for 'search/deposits').
  @Get('search/deposits-filtered')
  @ApiOperation({ summary: 'Search deposit accounts with filters (generic multi-field filter version)' })
  @ApiResponse({ status: 200, description: 'Deposit search results returned successfully' })
  async searchDeposits(@Query() filters: SearchFiltersDto): Promise<SearchResult<any>> {
    return this.searchService.searchDeposits(filters);
  }

  @Get('search/transactions')
  @ApiOperation({ summary: 'Search transactions with filters' })
  @ApiResponse({ status: 200, description: 'Transaction search results returned successfully' })
  async searchTransactions(@Query() filters: SearchFiltersDto): Promise<SearchResult<any>> {
    return this.searchService.searchTransactions(filters);
  }

  // Balance Inquiry Endpoints
  @Get('balance/member/:memberId')
  @ApiOperation({ summary: 'Get member balance inquiry' })
  @ApiResponse({ status: 200, description: 'Member balance returned successfully' })
  @ApiQuery({ name: 'asOfDate', required: false, description: 'Balance as of date (YYYY-MM-DD)' })
  async getMemberBalance(
    @Param('memberId', ParseIntPipe) memberId: number,
    @Query('asOfDate') asOfDate?: string,
  ): Promise<MemberBalance> {
    return this.balanceService.getMemberBalance({ memberId, asOfDate });
  }

  @Get('balance/account/:accountType/:accountId')
  @ApiOperation({ summary: 'Get account balance' })
  @ApiResponse({ status: 200, description: 'Account balance returned successfully' })
  async getAccountBalance(
    @Param('accountType') accountType: string,
    @Param('accountId', ParseIntPipe) accountId: number,
  ): Promise<AccountBalance> {
    return this.balanceService.getAccountBalance(accountType, accountId);
  }

  @Get('balance/member/:memberId/accounts')
  @ApiOperation({ summary: 'Get all account balances for a member' })
  @ApiResponse({ status: 200, description: 'Member account balances returned successfully' })
  async getMemberAccountBalances(@Param('memberId', ParseIntPipe) memberId: number) {
    return this.balanceService.getMemberAccountBalances(memberId);
  }

  @Get('balance/member/:memberId/realtime')
  @ApiOperation({ summary: 'Get real-time member balance' })
  @ApiResponse({ status: 200, description: 'Real-time balance returned successfully' })
  async getRealtimeBalance(@Param('memberId', ParseIntPipe) memberId: number): Promise<MemberBalance> {
    return this.balanceService.getRealtimeBalance(memberId);
  }

  // Account Statement Endpoints
  @Post('statement/generate')
  @ApiOperation({ summary: 'Generate account statement' })
  @ApiResponse({ status: 200, description: 'Account statement generated successfully' })
  async generateAccountStatement(@Body() statementDto: AccountStatementDto): Promise<AccountStatement> {
    return this.balanceService.generateAccountStatement(statementDto);
  }

  @Get('statement/member/:memberId')
  @ApiOperation({ summary: 'Generate member statement for date range' })
  @ApiResponse({ status: 200, description: 'Member statement generated successfully' })
  @ApiQuery({ name: 'fromDate', required: true, description: 'From date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'toDate', required: true, description: 'To date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'accountType', required: false, description: 'Account type filter' })
  @ApiQuery({ name: 'accountId', required: false, description: 'Account ID filter' })
  @ApiQuery({ name: 'includeClosed', required: false, description: 'Include closed accounts' })
  async getMemberStatement(
    @Param('memberId', ParseIntPipe) memberId: number,
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
    @Query('accountType') accountType?: string,
    @Query('accountId') accountId?: string,
    @Query('includeClosed') includeClosed?: string,
  ): Promise<AccountStatement> {
    const statementDto: AccountStatementDto = {
      memberId,
      fromDate,
      toDate,
      accountType,
      accountId: accountId ? parseInt(accountId) : undefined,
      includeClosed: includeClosed === 'true',
    };
    return this.balanceService.generateAccountStatement(statementDto);
  }

  // Interest Rate Update Endpoints - Temporarily disabled
  /*
  @Post('interest-rates/update')
  @ApiOperation({ summary: 'Update interest rates' })
  @ApiResponse({ status: 200, description: 'Interest rates updated successfully', type: InterestRateUpdateResultDto })
  async updateInterestRates(@Body() updateDto: InterestRateUpdateDto): Promise<InterestRateUpdateResultDto> {
    const serviceDto = {
      ...updateDto,
      effectiveDate: new Date(updateDto.effectiveDate),
    };
    return this.interestRateUpdateService.updateInterestRates(serviceDto);
  }

  @Post('interest-rates/bulk-update')
  @ApiOperation({ summary: 'Bulk update interest rates' })
  @ApiResponse({ status: 200, description: 'Interest rates bulk updated successfully', type: [InterestRateUpdateResultDto] })
  async bulkUpdateInterestRates(@Body() bulkUpdate: BulkInterestRateUpdateDto): Promise<InterestRateUpdateResultDto[]> {
    const serviceDto = {
      ...bulkUpdate,
      effectiveDate: new Date(bulkUpdate.effectiveDate),
    };
    return this.interestRateUpdateService.bulkUpdateInterestRates(serviceDto);
  }

  @Get('interest-rates/current')
  @ApiOperation({ summary: 'Get current interest rates' })
  @ApiResponse({ status: 200, description: 'Current interest rates returned successfully' })
  async getCurrentInterestRates() {
    return this.interestRateUpdateService.getCurrentInterestRates();
  }

  @Post('interest-rates/preview')
  @ApiOperation({ summary: 'Preview interest rate update impact' })
  @ApiResponse({ status: 200, description: 'Interest rate update preview generated successfully' })
  async previewInterestRateUpdate(@Body() updateDto: InterestRateUpdateDto) {
    const serviceDto = {
      ...updateDto,
      effectiveDate: new Date(updateDto.effectiveDate),
    };
    return this.interestRateUpdateService.previewInterestRateUpdate(serviceDto);
  }

  @Post('interest-rates/recalculate')
  @ApiOperation({ summary: 'Recalculate interest for affected accounts' })
  @ApiResponse({ status: 200, description: 'Interest recalculated successfully' })
  async recalculateInterest(@Body() recalculateDto: RecalculateInterestDto) {
    return this.interestRateUpdateService.recalculateInterestForAccounts(
      recalculateDto.accountType,
      recalculateDto.accountIds,
      new Date(recalculateDto.effectiveDate),
    );
  }
  */

  // Data Consistency Check Endpoints
  @Get('data-consistency/check')
  @ApiOperation({ summary: 'Run comprehensive data consistency checks' })
  @ApiResponse({ status: 200, description: 'Data consistency check completed successfully' })
  async runConsistencyChecks() {
    return this.dataConsistencyService.runConsistencyChecks();
  }

  // Data Correction Endpoints
  @Post('data-correction/auto-fix')
  @ApiOperation({ summary: 'Auto-fix consistency issues' })
  @ApiResponse({ status: 200, description: 'Auto-fix completed successfully', type: BulkCorrectionResultDto })
  async autoFixConsistencyIssues(): Promise<BulkCorrectionResultDto> {
    return this.dataCorrectionService.autoFixConsistencyIssues();
  }

  @Post('data-correction/orphaned-records')
  @ApiOperation({ summary: 'Fix orphaned records' })
  @ApiResponse({ status: 200, description: 'Orphaned records fixed successfully', type: CorrectionResultDto })
  async fixOrphanedRecords(@Body() fixes: OrphanedRecordFixDto[]): Promise<CorrectionResultDto> {
    return this.dataCorrectionService.fixOrphanedRecords(fixes);
  }

  @Post('data-correction/balance-discrepancies')
  @ApiOperation({ summary: 'Correct balance discrepancies' })
  @ApiResponse({ status: 200, description: 'Balance discrepancies corrected successfully', type: CorrectionResultDto })
  async correctBalanceDiscrepancies(@Body() corrections: BalanceCorrectionRequestDto[]): Promise<CorrectionResultDto> {
    return this.dataCorrectionService.correctBalanceDiscrepancies(corrections);
  }

  @Post('data-correction/remove-duplicates')
  @ApiOperation({ summary: 'Remove duplicate records' })
  @ApiResponse({ status: 200, description: 'Duplicate records removed successfully', type: CorrectionResultDto })
  async removeDuplicateRecords(@Body() removeDto: RemoveDuplicatesDto): Promise<CorrectionResultDto> {
    return this.dataCorrectionService.removeDuplicateRecords(
      removeDto.recordType,
      removeDto.keepStrategy,
      removeDto.manualKeepIds,
    );
  }

  @Post('data-correction/fix-integrity')
  @ApiOperation({ summary: 'Fix data integrity issues' })
  @ApiResponse({ status: 200, description: 'Data integrity issues fixed successfully', type: CorrectionResultDto })
  async fixDataIntegrityIssues(): Promise<CorrectionResultDto> {
    return this.dataCorrectionService.fixDataIntegrityIssues();
  }

  @Post('data-correction/recalculate-balances')
  @ApiOperation({ summary: 'Recalculate all balances' })
  @ApiResponse({ status: 200, description: 'All balances recalculated successfully', type: CorrectionResultDto })
  async recalculateAllBalances(): Promise<CorrectionResultDto> {
    return this.dataCorrectionService.recalculateAllBalances();
  }

  // System Health Monitoring Endpoints
  @Get('health/status')
  @ApiOperation({ summary: 'Get current system health status' })
  @ApiResponse({ status: 200, description: 'System health status returned successfully', type: SystemHealthMetricsDto })
  async getCurrentHealthStatus(): Promise<SystemHealthMetricsDto> {
    return this.systemHealthMonitoringService.getCurrentHealthStatus();
  }

  @Get('health/history')
  @ApiOperation({ summary: 'Get system health history' })
  @ApiResponse({ status: 200, description: 'System health history returned successfully', type: [SystemHealthMetricsDto] })
  @ApiQuery({ name: 'hours', required: false, description: 'Number of hours to look back (default: 24)' })
  async getHealthHistory(@Query('hours') hours?: string): Promise<SystemHealthMetricsDto[]> {
    const hoursNum = hours ? parseInt(hours) : 24;
    return this.systemHealthMonitoringService.getHealthHistory(hoursNum);
  }

  @Get('health/alerts')
  @ApiOperation({ summary: 'Get active health alerts' })
  @ApiResponse({ status: 200, description: 'Active health alerts returned successfully', type: [HealthAlertDto] })
  async getActiveAlerts(): Promise<HealthAlertDto[]> {
    return this.systemHealthMonitoringService.getActiveAlerts();
  }

  @Get('health/alerts/all')
  @ApiOperation({ summary: 'Get all health alerts' })
  @ApiResponse({ status: 200, description: 'All health alerts returned successfully', type: [HealthAlertDto] })
  @ApiQuery({ name: 'hours', required: false, description: 'Number of hours to look back (default: 24)' })
  async getAllAlerts(@Query('hours') hours?: string): Promise<HealthAlertDto[]> {
    const hoursNum = hours ? parseInt(hours) : 24;
    return this.systemHealthMonitoringService.getAllAlerts(hoursNum);
  }

  @Post('health/alerts/:alertId/resolve')
  @ApiOperation({ summary: 'Resolve a health alert' })
  @ApiResponse({ status: 200, description: 'Health alert resolved successfully' })
  async resolveAlert(@Param('alertId') alertId: string) {
    const resolved = this.systemHealthMonitoringService.resolveAlert(alertId);
    return { success: resolved, message: resolved ? 'Alert resolved' : 'Alert not found or already resolved' };
  }

  @Get('health/performance')
  @ApiOperation({ summary: 'Get performance metrics' })
  @ApiResponse({ status: 200, description: 'Performance metrics returned successfully', type: [PerformanceMetricsDto] })
  async getPerformanceMetrics(): Promise<PerformanceMetricsDto[]> {
    return this.systemHealthMonitoringService.getPerformanceMetrics();
  }

  @Get('health/diagnostics')
  @ApiOperation({ summary: 'Run comprehensive system diagnostics' })
  @ApiResponse({ status: 200, description: 'System diagnostics completed successfully' })
  async runSystemDiagnostics() {
    return this.systemHealthMonitoringService.runSystemDiagnostics();
  }

  // Legacy endpoint
  @ApiOperation({ summary: 'Legacy: list available utility services (index/health ping)' })
  @Get()
  async findAll() {
    return { 
      message: 'Utility services available',
      endpoints: {
        search: '/utilities/search/*',
        balance: '/utilities/balance/*',
        statement: '/utilities/statement/*',
        interestRates: '/utilities/interest-rates/*',
        dataConsistency: '/utilities/data-consistency/*',
        dataCorrection: '/utilities/data-correction/*',
        health: '/utilities/health/*'
      }
    };
  }
}
