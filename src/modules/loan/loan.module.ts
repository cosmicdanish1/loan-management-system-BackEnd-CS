import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { LoanController } from './loan.controller';
import { LoanService } from './loan.service';
import { LoanAccount, LoanPayment } from './entities';
import { Member } from '../member/entities/member.entity';
import { InterestCalculationService, DefaulterTrackingService, PaymentProcessingService } from './services';

@Module({
  imports: [
    TypeOrmModule.forFeature([LoanAccount, LoanPayment, Member]),
    ScheduleModule.forRoot(),
  ],
  controllers: [LoanController],
  providers: [LoanService, InterestCalculationService, DefaulterTrackingService, PaymentProcessingService],
  exports: [LoanService, InterestCalculationService, DefaulterTrackingService, PaymentProcessingService],
})
export class LoanModule {}
