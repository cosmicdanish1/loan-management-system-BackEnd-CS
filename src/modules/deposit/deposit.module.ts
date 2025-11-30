import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DepositController } from './deposit.controller';
import { DepositService } from './deposit.service';
import { CertificateService } from './services';
import { FixedDeposit, RecurringDeposit, RdInstallment } from './entities';
import { Member } from '../member/entities/member.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([FixedDeposit, RecurringDeposit, RdInstallment, Member]),
  ],
  controllers: [DepositController],
  providers: [DepositService, CertificateService],
  exports: [DepositService, CertificateService],
})
export class DepositModule {}
