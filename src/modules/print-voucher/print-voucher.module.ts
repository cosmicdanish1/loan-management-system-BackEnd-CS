import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PrintVoucherController } from './print-voucher.controller';
import { PrintVoucherService } from './print-voucher.service';
import { Transactions } from './entities/transactions.entity';
import { HeadMaster } from './entities/head-master.entity';
import { MemberMaster } from '@modules/member/entities/member-master.entity';

import { Ledger } from './entities/ledger.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([Transactions, HeadMaster, MemberMaster, Ledger]),
    ],
    controllers: [PrintVoucherController],
    providers: [PrintVoucherService],
})
export class PrintVoucherModule { }
