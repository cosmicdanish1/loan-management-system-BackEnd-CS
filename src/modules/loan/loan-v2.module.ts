import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoanAccount, LoanPayment, DemandMaster } from './entities';
import { LoanMaster } from './entities/loan-master.entity';
import { LoanPending } from './entities/loan-pending.entity';
import {
    LoanApplicationService,
    LoanSanctionService,
    LoanSuretyService,
    LoanQueryService,
    LoanRepaymentService,
    LoanEligibilityService,
    LoanMonthEndService,
    LoanPaymentFlagService,
    LoanPositionService,
    LoanReagreementService,
    ReagreementDocumentService,
} from './services-v2';
import { LoanV2Controller } from './loan-v2.controller';
import { LoanReagreementController } from './loan-reagreement.controller';

import { AdminModule } from '../admin/admin.module';
import { UtilityModule } from '../utility/utility.module';
import { RdModule } from '../rd/rd.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            LoanAccount,
            LoanPayment,
            LoanMaster,
            LoanPending,
            DemandMaster
        ]),
        AdminModule,
        UtilityModule,
        RdModule,
    ],
    controllers: [LoanV2Controller, LoanReagreementController],
    providers: [
        LoanApplicationService,
        LoanSanctionService,
        LoanSuretyService,
        LoanQueryService,
        LoanRepaymentService,
        LoanEligibilityService,
        LoanMonthEndService,
        LoanPaymentFlagService,
        LoanPositionService,
        LoanReagreementService,
        ReagreementDocumentService,
    ],
    exports: [
        LoanApplicationService,
        LoanSanctionService,
        LoanSuretyService,
        LoanQueryService,
        LoanRepaymentService,
        LoanEligibilityService,
        LoanMonthEndService,
        LoanReagreementService,
        ReagreementDocumentService,
    ],
})
export class LoanV2Module { }
