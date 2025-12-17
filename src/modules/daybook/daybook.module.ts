import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DayBookController } from './daybook.controller';
import { DayBookService } from './daybook.service';
import { Transactions } from '../cashbook/entities/transactions.entity';
import { Ledger } from '../cashbook/entities/ledger.entity';
import { MemberMaster } from '../member/entities/member-master.entity';
import { InterestMaster } from '../interest/entities/interest-master.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Transactions,
      Ledger,
      MemberMaster,
      InterestMaster
    ])
  ],
  controllers: [DayBookController],
  providers: [DayBookService],
  exports: [DayBookService]
})
export class DayBookModule {}