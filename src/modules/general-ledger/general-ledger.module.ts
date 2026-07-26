import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeneralLedgerController } from './general-ledger.controller';
import { GeneralLedgerService } from './general-ledger.service';
import { Ledger } from '../member-ledger/entities/ledger.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ledger])
  ],
  controllers: [GeneralLedgerController],
  providers: [GeneralLedgerService],
  exports: [GeneralLedgerService]
})
export class GeneralLedgerModule {}