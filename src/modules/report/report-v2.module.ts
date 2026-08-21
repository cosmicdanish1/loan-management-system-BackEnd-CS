import { Module } from '@nestjs/common';
import {
    CashBookReportsService,
    MemberReportsService,
    LoanReportsService,
    DividendReportsService,
    DepositReportsService,
    FinancialStatementsService,
    UtilityReportsService,
    ProfitDistributionService,
} from './services-v2';
import { AdminModule } from '../admin/admin.module';
import { LoanV2Module } from '../loan/loan-v2.module';
import { ReportV2Controller } from './report-v2.controller';

/**
 * Report V2 Module - Restructured report module with separated services.
 * 
 * @version 2.0 - Part of backend restructuring
 * 
 * Original: report.service.ts (127KB, 3296 lines, 56 methods)
 * Split into 7 focused services for better maintainability.
 * 
 * This module runs alongside the original ReportModule during migration.
 * Routes are prefixed with /v2/ to avoid conflicts.
 */
@Module({
    imports: [AdminModule, LoanV2Module],
    controllers: [ReportV2Controller],
    providers: [
        CashBookReportsService,
        MemberReportsService,
        LoanReportsService,
        DividendReportsService,
        DepositReportsService,
        UtilityReportsService,
        FinancialStatementsService,
        ProfitDistributionService,
    ],
    exports: [
        CashBookReportsService,
        MemberReportsService,
        LoanReportsService,
        DividendReportsService,
        DepositReportsService,
        UtilityReportsService,
        FinancialStatementsService,
        ProfitDistributionService,
    ],
})
export class ReportV2Module { }
