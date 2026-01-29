import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DepositController } from './deposit.controller';
import { DepositService } from './deposit.service';
import { CertificateService } from './services';
import { FixedDeposit, RecurringDeposit, RdInstallment } from './entities';
import { Member } from '../member/entities/member.entity';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([FixedDeposit, RecurringDeposit, RdInstallment, Member]),
    AdminModule,
  ],
  controllers: [DepositController],
  providers: [DepositService, CertificateService],
  exports: [DepositService, CertificateService],
})
export class DepositModule { }
