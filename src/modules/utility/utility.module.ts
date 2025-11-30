import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UtilityController } from './utility.controller';
import { UtilityService } from './utility.service';
import { SearchService } from './services/search.service';
import { BalanceService } from './services/balance.service';
import { CalculationService } from './services/calculation.service';
// import { InterestRateUpdateService } from './services/interest-rate-update.service';
import { DataConsistencyService } from './services/data-consistency.service';
import { DataCorrectionService } from './services/data-correction.service';
import { SystemHealthMonitoringService } from './services/system-health-monitoring.service';
import { Member } from '../member/entities/member.entity';
import { LoanAccount } from '../loan/entities/loan-account.entity';
import { LoanPayment } from '../loan/entities/loan-payment.entity';
import { FixedDeposit } from '../deposit/entities/fixed-deposit.entity';
import { Transaction } from '../transaction/entities/transaction.entity';
import { InterestRate } from '../admin/entities/interest-rate.entity';
import { SystemConfig } from '../admin/entities/system-config.entity';
import { DepositSlab } from '../admin/entities/deposit-slab.entity';
// import { SystemConfigService } from '../admin/services/system-config.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Member,
      LoanAccount,
      LoanPayment,
      FixedDeposit,
      Transaction,
      InterestRate,
      SystemConfig,
      DepositSlab,
    ]),
  ],
  controllers: [UtilityController],
  providers: [
    UtilityService,
    SearchService,
    BalanceService,
    CalculationService,
    // InterestRateUpdateService,
    DataConsistencyService,
    DataCorrectionService,
    SystemHealthMonitoringService,
    // SystemConfigService,
  ],
  exports: [
    UtilityService,
    SearchService,
    BalanceService,
    CalculationService,
    // InterestRateUpdateService,
    DataConsistencyService,
    DataCorrectionService,
    SystemHealthMonitoringService,
  ],
})
export class UtilityModule {}
