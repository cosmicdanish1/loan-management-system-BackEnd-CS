import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { LoanController } from './loan.controller';
import { LoanService } from './loan.service';
import { LoanAccount, LoanPayment } from './entities';
import { LoanMaster } from './entities/loan-master.entity';
import { LoanPending } from './entities/loan-pending.entity';
import { Member } from '../member/entities/member.entity';
import { MemberMaster } from '../member/entities/member-master.entity';
import { InterestCalculationService, DefaulterTrackingService, PaymentProcessingService } from './services';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      LoanAccount, 
      LoanPayment, 
      LoanMaster, 
      LoanPending, 
      Member, 
      MemberMaster
    ]),
    ScheduleModule.forRoot(),
  ],
  controllers: [LoanController],
  providers: [LoanService, InterestCalculationService, DefaulterTrackingService, PaymentProcessingService],
  exports: [LoanService, InterestCalculationService, DefaulterTrackingService, PaymentProcessingService],
})
export class LoanModule {}
