import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InterestController } from './interest.controller';
import { InterestService } from './interest.service';
import { InterestMaster } from './entities/interest-master.entity';
import { InterestPaid } from './entities/interest-paid.entity';
import { Ledger } from './entities/ledger.entity';
import { MemberMaster } from '../member/entities/member-master.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InterestMaster,
      InterestPaid,
      Ledger,
      MemberMaster,
    ]),
  ],
  controllers: [InterestController],
  providers: [InterestService],
  exports: [InterestService],
})
export class InterestModule {}