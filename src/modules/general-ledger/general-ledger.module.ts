import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeneralLedgerController } from './general-ledger.controller';
import { GeneralLedgerService } from './general-ledger.service';
import { Ledger } from '../member-ledger/entities/ledger.entity';
import { HeadMaster } from '../consolidation/entities/head-master.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ledger, HeadMaster])
  ],
  controllers: [GeneralLedgerController],
  providers: [GeneralLedgerService],
  exports: [GeneralLedgerService]
})
export class GeneralLedgerModule {}