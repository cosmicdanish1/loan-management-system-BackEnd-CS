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
    LoanMonthEndService,
    LoanEligibilityService,
} from './services-v2';
import { LoanV2Controller } from './loan-v2.controller';

import { AdminModule } from '../admin/admin.module';
import { UtilityModule } from '../utility/utility.module';

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
    ],
    controllers: [LoanV2Controller],
    providers: [
        LoanApplicationService,
        LoanSanctionService,
        LoanSuretyService,
        LoanQueryService,
        LoanRepaymentService,
        LoanMonthEndService,
        LoanEligibilityService,
    ],
    exports: [
        LoanApplicationService,
        LoanSanctionService,
        LoanSuretyService,
        LoanQueryService,
        LoanRepaymentService,
        LoanMonthEndService,
        LoanEligibilityService,
    ],
})
export class LoanV2Module { }
