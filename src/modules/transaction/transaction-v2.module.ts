import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { Transaction } from './entities/transaction.entity';
import { Voucher } from './entities/voucher.entity';
import { DemandMaster } from './entities/demand-master.entity';
import { ShortRecoveryAdjustment } from './entities/short-recovery-adjustment.entity';
import { TransactionV2Controller } from './transaction-v2.controller';
import { ShortRecoveryController } from './short-recovery.controller';
import { DemandGenerationController } from './demand-generation.controller'; // New
import { LedgerPostingController } from './ledger-posting.controller'; // New
import { DemandReportController } from './demand-report.controller'; // New
import {
    VoucherService,
    PassTransactionService,
    ShortRecoveryService,
    DemandGenerationService,
    LedgerPostingService,
    DemandReportService,
    CompulsoryDepositService,
    JournalTransferService
} from './services-v2';
import { CompulsoryDepositController } from './compulsory-deposit.controller';
import { JournalTransferController } from './journal-transfer.controller';

@Module({
    imports: [
        AdminModule,
        TypeOrmModule.forFeature([
            Transaction,
            Voucher,
            DemandMaster,
            ShortRecoveryAdjustment
        ]),
    ],
    controllers: [
        TransactionV2Controller,
        ShortRecoveryController,
        DemandGenerationController, // Register
        LedgerPostingController, // Register
        DemandReportController, // Register
        CompulsoryDepositController,
        JournalTransferController
    ],
    providers: [
        VoucherService,
        PassTransactionService,
        ShortRecoveryService,
        DemandGenerationService, // Register
        LedgerPostingService, // Register
        DemandReportService, // Register
        CompulsoryDepositService,
        JournalTransferService
    ],
    exports: [
        VoucherService,
        PassTransactionService,
        ShortRecoveryService,
        DemandGenerationService,
        LedgerPostingService,
        DemandReportService,
        CompulsoryDepositService,
        JournalTransferService
    ]
})
export class TransactionV2Module { }
