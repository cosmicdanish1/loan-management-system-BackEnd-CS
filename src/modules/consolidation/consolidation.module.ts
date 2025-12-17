import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConsolidationController } from './consolidation.controller';
import { ConsolidationService } from './consolidation.service';
import { Transactions } from '../cashbook/entities/transactions.entity';
import { HeadMaster } from './entities/head-master.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transactions, HeadMaster])
  ],
  controllers: [ConsolidationController],
  providers: [ConsolidationService],
  exports: [ConsolidationService]
})
export class ConsolidationModule {}