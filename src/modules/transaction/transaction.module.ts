import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionController } from './transaction.controller';
import { VoucherController } from './voucher.controller';
import { PaymentController } from './payment.controller';
import { TransactionService } from './transaction.service';
import { PaymentService } from './services/payment.service';
import { Transaction, Voucher } from './entities';
import { Member } from '../member/entities/member.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Transaction, Voucher, Member])],
  controllers: [TransactionController, VoucherController, PaymentController],
  providers: [TransactionService, PaymentService],
  exports: [TransactionService, PaymentService],
})
export class TransactionModule {}
