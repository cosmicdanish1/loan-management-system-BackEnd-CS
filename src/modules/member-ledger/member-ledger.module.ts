import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MemberLedgerController } from './member-ledger.controller';
import { MemberLedgerService } from './member-ledger.service';
import { Ledger } from './entities/ledger.entity';
import { MemberMaster } from '../member/entities/member-master.entity';
import { HeadMaster } from '../consolidation/entities/head-master.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ledger, MemberMaster, HeadMaster])
  ],
  controllers: [MemberLedgerController],
  providers: [MemberLedgerService],
  exports: [MemberLedgerService]
})
export class MemberLedgerModule {}