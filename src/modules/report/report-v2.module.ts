import { Module } from '@nestjs/common';
import {
    CashBookReportsService,
    MemberReportsService,
    LoanReportsService,
    DividendReportsService,
    DepositReportsService,
    UtilityReportsService,
} from './services-v2';
import { ReportV2Controller } from './report-v2.controller';

/**
 * Report V2 Module - Restructured report module with separated services.
 * 
 * @version 2.0 - Part of backend restructuring
 * 
 * Original: report.service.ts (127KB, 3296 lines, 56 methods)
 * Split into 6 focused services for better maintainability.
 * 
 * This module runs alongside the original ReportModule during migration.
 * Routes are prefixed with /v2/ to avoid conflicts.
 */
@Module({
    imports: [],
    controllers: [ReportV2Controller],
    providers: [
        CashBookReportsService,
        MemberReportsService,
        LoanReportsService,
        DividendReportsService,
        DepositReportsService,
        UtilityReportsService,
    ],
    exports: [
        CashBookReportsService,
        MemberReportsService,
        LoanReportsService,
        DividendReportsService,
        DepositReportsService,
        UtilityReportsService,
    ],
})
export class ReportV2Module { }
