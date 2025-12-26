import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CashBookController } from './cashbook.controller';
import { CashBookService } from './cashbook.service';
import { Ledger } from './entities/ledger.entity';
import { MemberMaster } from '../member/entities/member-master.entity';
import { InterestMaster } from '../interest/entities/interest-master.entity';
import { Transactions } from './entities/transactions.entity';
import { HeadMaster } from '../print-voucher/entities/head-master.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Ledger,
      MemberMaster,
      InterestMaster,
      Transactions,
      HeadMaster
    ])
  ],
  controllers: [CashBookController],
  providers: [CashBookService],
  exports: [CashBookService]
})
export class CashBookModule { }