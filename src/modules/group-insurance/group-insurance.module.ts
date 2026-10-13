import { Module } from '@nestjs/common';
import { GroupInsuranceController } from './group-insurance.controller';
import { GroupInsuranceService } from './group-insurance.service';

// ES-98: yearly group insurance (lump sum split over active members, deducted from RD at year end).
@Module({
  controllers: [GroupInsuranceController],
  providers: [GroupInsuranceService],
  exports: [GroupInsuranceService],
})
export class GroupInsuranceModule {}
