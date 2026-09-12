import { Module } from '@nestjs/common';
import { RdRulesService } from './rd-rules.service';
import { RdMemberConfigService } from './services/rd-member-config.service';
import { RdMemberConfigController } from './controllers/rd-member-config.controller';
import { RdBalanceEventsService } from './services/rd-balance-events.service';
import { RdBalanceEventsController } from './controllers/rd-balance-events.controller';
import { RdPatternEligibilityService } from './services/rd-pattern-eligibility.service';
import { RdPatternEligibilityController } from './controllers/rd-pattern-eligibility.controller';
import { RdInterestCalculationService } from './services/rd-interest-calculation.service';
import { RdInterestCalculationController } from './controllers/rd-interest-calculation.controller';
import { RdFinancialYearClosingService } from './services/rd-financial-year-closing.service';
import { RdFinancialYearClosingController } from './controllers/rd-financial-year-closing.controller';
import { RdRepaymentService } from './services/rd-repayment.service';
import { RdRepaymentController } from './controllers/rd-repayment.controller';

/**
 * The new RD (Recurring Deposit) system, built from scratch to replace the
 * fdmaster-based account system removed earlier this session. Grows here as
 * each build step lands: member config, installment collection (the Excel
 * demand-import path lives in the transaction module's demand-import
 * pipeline, not here; the counter/window path is RdRepaymentService),
 * balance events / withdrawal, the payment-pattern engine, the two
 * independent interest calculators, financial-year closing, and reporting.
 */
@Module({
    providers: [
        RdRulesService,
        RdMemberConfigService,
        RdBalanceEventsService,
        RdPatternEligibilityService,
        RdInterestCalculationService,
        RdFinancialYearClosingService,
        RdRepaymentService,
    ],
    controllers: [
        RdMemberConfigController,
        RdBalanceEventsController,
        RdPatternEligibilityController,
        RdInterestCalculationController,
        RdFinancialYearClosingController,
        RdRepaymentController,
    ],
    exports: [
        RdRulesService,
        RdMemberConfigService,
        RdBalanceEventsService,
        RdPatternEligibilityService,
        RdInterestCalculationService,
        RdFinancialYearClosingService,
        RdRepaymentService,
    ],
})
export class RdModule { }
