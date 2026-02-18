import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InterestController } from './interest.controller';
import { InterestService } from './interest.service';
import { InterestMaster } from './entities/interest-master.entity';
import { InterestPaid } from './entities/interest-paid.entity';
import { FundsMaster } from '../admin/entities/funds-master.entity';
import { Ledger } from './entities/ledger.entity';
import { MemberMaster } from '../member/entities/member-master.entity';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InterestMaster,
      InterestPaid,
      Ledger,
      MemberMaster,
      FundsMaster,
    ]),
    AdminModule,
  ],
  controllers: [InterestController],
  providers: [InterestService],
  exports: [InterestService],
})
export class InterestModule { }