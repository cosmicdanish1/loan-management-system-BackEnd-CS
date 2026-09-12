import { Module } from '@nestjs/common';
import { ShareMonthEndService } from './services/share-month-end.service';
import { DividendCalculationService } from './services/dividend-calculation.service';
import { DividendCreditService } from './services/dividend-credit.service';
import { ShareMonthEndController } from './controllers/share-month-end.controller';
import { DividendCalculationController } from './controllers/dividend-calculation.controller';
import { DividendCreditController } from './controllers/dividend-credit.controller';
import { SharedModule } from '../shared/shared.module';

/**
 * Dividend calculation and credit, built from scratch — the existing
 * dividend-payment path (transaction/services-v2/dividend-payment.service.ts)
 * only ever marks an already-calculated dividend_master row as paid;
 * nothing previously calculated or credited one. Two deliberately separate
 * steps live here: monthly Share Capital snapshot + Total Product
 * calculation (DividendCalculationService, writes dividend_master), and
 * Dividend Credit (DividendCreditService, applies a PRIOR year's already-
 * calculated dividend into Share Value at the CURRENT year's close) — the
 * Calculation Year / Credit Year separation the user's spec requires.
 */
@Module({
    imports: [SharedModule],
    providers: [ShareMonthEndService, DividendCalculationService, DividendCreditService],
    controllers: [ShareMonthEndController, DividendCalculationController, DividendCreditController],
    exports: [ShareMonthEndService, DividendCalculationService, DividendCreditService],
})
export class DividendModule {}
